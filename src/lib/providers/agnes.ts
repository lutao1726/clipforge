/**
 * Agnes AI provider.
 *
 * Images use the synchronous OpenAI-compatible generations endpoint. Videos use
 * Agnes's asynchronous videos endpoint and are queried by video_id + model_name.
 */
import { assertPublicUrl } from '@/lib/ssrf-guard'
import { BaseProvider, ProviderError } from './base'
import type {
  ImageOptions,
  ImageResult,
  MediaType,
  Model,
  ProviderConfig,
  TaskStatus,
  TaskStatusEnum,
  VideoOptions,
  VideoResult,
} from './types'

const IMAGE_MODEL = 'agnes-image-2.5-flash'
const VIDEO_MODELS = new Set(['agnes-video-2.5', 'agnes-video-2.5-flash'])

interface AgnesImageResponse {
  created?: number
  data?: Array<{ url?: string | null; b64_json?: string | null }>
}

interface AgnesVideoResponse {
  id?: string
  task_id?: string
  video_id?: string
  model?: string
  status?: string
  progress?: number
  created_at?: number
  completed_at?: number | null
  seconds?: string
  url?: string
  metadata?: { url?: string; [key: string]: unknown } | null
  error?: string | { message?: string; code?: string } | null
}

export class AgnesProvider extends BaseProvider {
  readonly name = 'agnes'
  readonly displayName = 'Agnes AI'

  constructor(config: ProviderConfig) {
    const configured = (config.baseUrl || 'https://apihub.agnes-ai.com/v1').replace(/\/+$/, '')
    // Agnes's media creation endpoints live below /v1, while /agnesapi is at the origin root.
    const root = configured.replace(/\/v1$/i, '')
    super({ ...config, baseUrl: root })
  }

  async generateImage(options: ImageOptions): Promise<ImageResult> {
    if (options.modelId !== IMAGE_MODEL) {
      throw new ProviderError(`不支持的 Agnes 图片模型: ${options.modelId}`, 'MODEL_NOT_SUPPORTED', this.name)
    }

    const refs = [
      ...(options.referenceImageUrl ? [options.referenceImageUrl] : []),
      ...(options.referenceImageUrls ?? []),
    ].filter((value, index, all) => all.indexOf(value) === index)

    if (options.mode === 'image-to-image' && refs.length === 0) {
      throw new ProviderError('Agnes 图生图缺少参考图片', 'BAD_REFERENCE', this.name)
    }

    const count = Math.max(1, Math.min(4, Math.round(options.count ?? 1)))
    const imageUrls: string[] = []
    const failures: string[] = []
    let created = Date.now()

    // Agnes does not expose an `n` field. Keep each paid creation request independent
    // and never retry the POST implicitly; aggregate partial success for count > 1.
    for (let i = 0; i < count; i++) {
      try {
        const response = await this.request<AgnesImageResponse>('/v1/images/generations', {
          method: 'POST',
          timeout: 360000,
          body: {
            model: options.modelId,
            prompt: options.prompt,
            size: this.imageSize(options.width, options.height),
            ratio: this.aspectRatio(options.width, options.height),
            extra_body: {
              ...(refs.length > 0 && { image: refs }),
              response_format: 'url',
            },
          },
        })
        created = response.created ? response.created * 1000 : created
        const urls = (response.data ?? [])
          .map((item) => item.url ?? undefined)
          .filter((url): url is string => Boolean(url))
        if (urls.length === 0) throw new ProviderError('生成成功但未返回图片地址', 'NO_RESULT', this.name)
        imageUrls.push(...urls)
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error))
      }
    }

    if (imageUrls.length === 0) {
      throw new ProviderError(failures[0] ?? 'Agnes 图片生成失败', 'NO_RESULT', this.name)
    }

    return {
      taskId: `agnes-img-${created}`,
      imageUrls,
      modelId: options.modelId,
      ...(failures.length > 0 && { extra: { requestedCount: count, failedCount: failures.length, failures } }),
    }
  }

  async generateVideo(options: VideoOptions): Promise<VideoResult> {
    const { taskId, modelId } = await this.submitVideoTask(options)
    const status = await this.waitForTask(taskId, { interval: 5000, modelId })
    return this.requireResult(status.result) as VideoResult
  }

  async submitVideoTask(options: VideoOptions): Promise<{ taskId: string; modelId: string }> {
    if (!VIDEO_MODELS.has(options.modelId)) {
      throw new ProviderError(`不支持的 Agnes 视频模型: ${options.modelId}`, 'MODEL_NOT_SUPPORTED', this.name)
    }

    const referenceImages = options.referenceImageUrls ?? []
    const referenceVideos = options.referenceVideoUrls ?? []
    const referenceAudios = options.referenceAudioUrls ?? []
    const hasReferences = referenceImages.length + referenceVideos.length + referenceAudios.length > 0
    const hasKeyframes = Boolean(options.firstFrameUrl || options.lastFrameUrl)

    if (hasReferences && hasKeyframes) {
      throw new ProviderError(
        'Agnes 视频不能在同一任务中混用关键帧和参考素材 / Agnes video cannot mix keyframes with reference media',
        'MODE_CONFLICT',
        this.name
      )
    }
    if (options.modelId === 'agnes-video-2.5-flash' && referenceImages.length > 5) {
      throw new ProviderError('Agnes Video 2.5 Flash 最多支持 5 张参考图片', 'TOO_MANY_REFERENCES', this.name)
    }
    if (options.modelId === 'agnes-video-2.5-flash' && referenceVideos.length > 0) {
      throw new ProviderError('Agnes Video 2.5 Flash 不支持参考视频', 'NOT_SUPPORTED', this.name)
    }

    const mediaUrls = [
      options.firstFrameUrl,
      options.lastFrameUrl,
      ...referenceImages,
      ...referenceVideos,
      ...referenceAudios,
    ].filter((url): url is string => Boolean(url))
    for (const url of mediaUrls) await this.assertPublicMediaUrl(url)

    const mode = hasReferences ? 'reference' : hasKeyframes ? 'keyframe' : 'text'
    const body: Record<string, unknown> = {
      model: options.modelId,
      prompt: options.prompt,
      mode,
      seconds: String(this.duration(options.duration)),
      size: '720P',
      aspect_ratio: this.aspectRatio(options.width, options.height),
      ...(options.seed != null && { seed: options.seed }),
      n: 1,
    }

    if (mode === 'keyframe') {
      if (options.firstFrameUrl) body.first_frame = options.firstFrameUrl
      if (options.lastFrameUrl) body.last_frame = options.lastFrameUrl
    } else if (mode === 'reference') {
      if (referenceImages.length > 0) body.images = referenceImages
      if (referenceAudios.length > 0) body.audios = referenceAudios
      if (referenceVideos.length > 0) {
        body.videos = referenceVideos.map((url) => ({ url, start_seconds: 0, require_audio: false }))
      }
    }

    const response = await this.request<AgnesVideoResponse>('/v1/videos', {
      method: 'POST',
      body,
      timeout: 120000,
    })
    const taskId = response.video_id
    if (!taskId) throw new ProviderError('Agnes 未返回 video_id', 'NO_TASK_ID', this.name)
    return { taskId, modelId: options.modelId }
  }

  async getTaskStatus(taskId: string, context?: { modelId?: string }): Promise<TaskStatus> {
    const query = new URLSearchParams({ video_id: taskId })
    if (context?.modelId) query.set('model_name', context.modelId)
    const response = await this.request<AgnesVideoResponse>(`/agnesapi?${query.toString()}`)
    const status = this.mapStatus(response.status)
    const modelId = response.model ?? context?.modelId ?? ''
    const taskStatus: TaskStatus = {
      taskId,
      status,
      progress: response.progress,
      createdAt: this.toIso(response.created_at),
      updatedAt: this.toIso(response.completed_at ?? undefined),
    }

    // Agnes currently returns the completed media URL at the top level (`url`).
    // Keep `metadata.url` as a compatibility fallback for older responses.
    const resultUrl = response.url ?? response.metadata?.url
    if (status === 'completed' && resultUrl) {
      taskStatus.result = {
        taskId,
        videoUrls: [resultUrl],
        duration: response.seconds ? Number(response.seconds) : undefined,
        modelId,
        hasAudio: true,
        ...(response.metadata && { extra: response.metadata }),
      }
    }
    if (status === 'completed' && !resultUrl) {
      taskStatus.status = 'failed'
      taskStatus.error = '任务完成但未返回视频地址（url/metadata.url）'
      taskStatus.errorCode = 'NO_RESULT'
    }
    if (status === 'failed') {
      taskStatus.error = typeof response.error === 'string' ? response.error : response.error?.message ?? '未知错误'
      taskStatus.errorCode = typeof response.error === 'object' && response.error?.code ? response.error.code : 'TASK_FAILED'
    }
    return taskStatus
  }

  async listModels(mediaType?: MediaType): Promise<Model[]> {
    const models: Model[] = [
      {
        id: IMAGE_MODEL,
        name: 'Agnes Image 2.5 Flash',
        description: '文生图、图生图和多图合成，支持复杂构图与高信息密度画面',
        modes: ['text-to-image', 'image-to-image'],
        mediaType: 'image',
        provider: this.name,
      },
      {
        id: 'agnes-video-2.5-flash',
        name: 'Agnes Video 2.5 Flash',
        description: '720P 快速视频生成，支持文生视频、关键帧和图片/音频参考',
        modes: ['text-to-video', 'image-to-video'],
        mediaType: 'video',
        provider: this.name,
        supportsAudio: true,
      },
      {
        id: 'agnes-video-2.5',
        name: 'Agnes Video 2.5',
        description: '720P 视频生成，支持首尾帧和图片、音频、视频参考',
        modes: ['text-to-video', 'image-to-video', 'video-to-video'],
        mediaType: 'video',
        provider: this.name,
        supportsAudio: true,
      },
    ]
    return mediaType ? models.filter((model) => model.mediaType === mediaType) : models
  }

  private imageSize(width?: number, height?: number): '1K' | '2K' {
    return Math.max(width ?? 1024, height ?? 1024) <= 1024 ? '1K' : '2K'
  }

  private aspectRatio(width?: number, height?: number): '9:16' | '16:9' | '1:1' {
    const ratio = (width ?? 1) / (height ?? 1)
    if (ratio < 0.8) return '9:16'
    if (ratio > 1.25) return '16:9'
    return '1:1'
  }

  private duration(value?: number): number {
    return Math.max(4, Math.min(12, Math.round(value ?? 5)))
  }

  private async assertPublicMediaUrl(url: string): Promise<void> {
    if (!/^https?:\/\//i.test(url) || /^https?:\/\/(?:localhost|127\.|\[::1\])/i.test(url)) {
      throw new ProviderError(
        `Agnes 视频仅支持公网 HTTP(S) 素材 URL / Agnes video requires a publicly reachable HTTP(S) media URL: ${url.slice(0, 80)}`,
        'PUBLIC_URL_REQUIRED',
        this.name
      )
    }
    try {
      await assertPublicUrl(url)
    } catch (error) {
      throw new ProviderError(
        `Agnes 视频素材不是可用的公网 URL / Agnes video media is not publicly reachable: ${error instanceof Error ? error.message : String(error)}`,
        'PUBLIC_URL_REQUIRED',
        this.name
      )
    }
  }

  private mapStatus(status?: string): TaskStatusEnum {
    const value = status?.toLowerCase()
    if (value === 'completed' || value === 'succeeded') return 'completed'
    if (value === 'failed' || value === 'error') return 'failed'
    if (value === 'cancelled' || value === 'canceled') return 'cancelled'
    if (value === 'in_progress' || value === 'processing' || value === 'running') return 'processing'
    return 'pending'
  }

  private toIso(seconds?: number | null): string | undefined {
    return seconds ? new Date(seconds * 1000).toISOString() : undefined
  }
}
