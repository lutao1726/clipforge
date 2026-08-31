import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgnesProvider } from '@/lib/providers/agnes'
import { ProviderError } from '@/lib/providers/base'
import { createProvider } from '@/lib/providers'
import { migrateSettings, type SettingsState } from '@/lib/stores/settings-store'

const config = { name: 'agnes', apiKey: 'test-key', baseUrl: '' }

function internal(provider: AgnesProvider) {
  return provider as unknown as {
    request: ReturnType<typeof vi.fn>
    assertPublicMediaUrl: ReturnType<typeof vi.fn>
  }
}

describe('AgnesProvider', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('adds the disabled Agnes default to persisted settings without changing existing providers', () => {
    const state = {
      providers: { openai: { enabled: true, apiKey: 'openai-key' } },
      llm: { provider: '', baseUrl: '', apiKey: '', model: '' },
    } as unknown as SettingsState

    const migrated = migrateSettings(state)

    expect(migrated.providers.openai).toEqual({ enabled: true, apiKey: 'openai-key' })
    expect(migrated.providers.agnes).toEqual({
      enabled: false,
      apiKey: '',
      baseUrl: 'https://apihub.agnes-ai.com/v1',
    })
  })

  it('migrates the retired Agnes Image 2.1 model to Image 2.5 Flash', () => {
    const migrated = migrateSettings({
      providers: { agnes: { enabled: true, apiKey: 'key' } },
      defaultImageModel: 'agnes-image-2.1-flash',
      customModels: [{ id: 'm', provider: 'agnes', modelId: 'agnes-image-2.1-flash', name: 'Agnes Image 2.1 Flash', mediaType: 'image' }],
    } as unknown as SettingsState)

    expect(migrated.defaultImageModel).toBe('agnes-image-2.5-flash')
    expect(migrated.customModels?.[0]).toMatchObject({ modelId: 'agnes-image-2.5-flash', name: 'Agnes Image 2.5 Flash' })
  })

  it('is registered and publishes only the selected current models', async () => {
    const provider = createProvider(config)
    expect(provider).toBeInstanceOf(AgnesProvider)
    expect((await provider.listModels()).map((model) => model.id)).toEqual([
      'agnes-image-2.5-flash',
      'agnes-video-2.5-flash',
      'agnes-video-2.5',
    ])
  })

  it('maps text-to-image to 1K square generations', async () => {
    const provider = new AgnesProvider(config)
    const request = vi.spyOn(internal(provider), 'request').mockResolvedValue({
      created: 123,
      data: [{ url: 'https://cdn.example/image.png' }],
    })
    const result = await provider.generateImage({
      modelId: 'agnes-image-2.5-flash',
      mode: 'text-to-image',
      prompt: 'product',
      width: 1024,
      height: 1024,
    })
    expect(result.imageUrls).toEqual(['https://cdn.example/image.png'])
    expect(request).toHaveBeenCalledWith('/v1/images/generations', expect.objectContaining({
      method: 'POST',
      body: {
        model: 'agnes-image-2.5-flash',
        prompt: 'product',
        size: '1K',
        ratio: '1:1',
        extra_body: { response_format: 'url' },
      },
    }))
  })

  it('maps local image-edit references to extra_body.image and a 2K portrait request', async () => {
    const provider = new AgnesProvider(config)
    const request = vi.spyOn(internal(provider), 'request').mockResolvedValue({ data: [{ url: 'https://cdn.example/edit.png' }] })
    await provider.generateImage({
      modelId: 'agnes-image-2.5-flash',
      mode: 'image-to-image',
      prompt: 'edit',
      width: 1080,
      height: 1920,
      referenceImageUrl: 'data:image/png;base64,one',
      referenceImageUrls: ['data:image/png;base64,two'],
    })
    const body = request.mock.calls[0][1]?.body as Record<string, unknown>
    expect(body).toMatchObject({ size: '2K', ratio: '9:16' })
    expect(body.extra_body).toEqual({
      image: ['data:image/png;base64,one', 'data:image/png;base64,two'],
      response_format: 'url',
    })
  })

  it('aggregates partial success when count requires separate Agnes requests', async () => {
    const provider = new AgnesProvider(config)
    vi.spyOn(internal(provider), 'request')
      .mockResolvedValueOnce({ data: [{ url: 'https://cdn.example/one.png' }] })
      .mockRejectedValueOnce(new ProviderError('rate limited', 'API_ERROR', 'agnes', 429))
    const result = await provider.generateImage({
      modelId: 'agnes-image-2.5-flash',
      mode: 'text-to-image',
      prompt: 'x',
      count: 2,
    })
    expect(result.imageUrls).toEqual(['https://cdn.example/one.png'])
    expect(result.extra).toMatchObject({ requestedCount: 2, failedCount: 1 })
  })

  it('fails when Agnes returns no URL for every requested image', async () => {
    const provider = new AgnesProvider(config)
    vi.spyOn(internal(provider), 'request').mockResolvedValue({ data: [] })

    await expect(provider.generateImage({
      modelId: 'agnes-image-2.5-flash',
      mode: 'text-to-image',
      prompt: 'x',
      count: 2,
    })).rejects.toMatchObject({ code: 'NO_RESULT' })
  })

  it('builds text, keyframe and reference video modes at 720P', async () => {
    const cases = [
      { input: {}, mode: 'text' },
      { input: { firstFrameUrl: 'https://media.example/first.png', lastFrameUrl: 'https://media.example/last.png' }, mode: 'keyframe' },
      {
        input: {
          referenceImageUrls: ['https://media.example/ref.png'],
          referenceAudioUrls: ['https://media.example/ref.mp3'],
          referenceVideoUrls: ['https://media.example/ref.mp4'],
        },
        mode: 'reference',
      },
    ]

    for (const entry of cases) {
      const provider = new AgnesProvider(config)
      vi.spyOn(internal(provider), 'assertPublicMediaUrl').mockResolvedValue(undefined)
      const request = vi.spyOn(internal(provider), 'request').mockResolvedValue({ video_id: `video-${entry.mode}` })
      const submitted = await provider.submitVideoTask({
        modelId: 'agnes-video-2.5',
        mode: 'text-to-video',
        prompt: 'x',
        width: 1920,
        height: 1080,
        duration: 20,
        ...entry.input,
      })
      expect(submitted).toEqual({ taskId: `video-${entry.mode}`, modelId: 'agnes-video-2.5' })
      const body = request.mock.calls[0][1]?.body as Record<string, unknown>
      expect(body).toMatchObject({ mode: entry.mode, size: '720P', aspect_ratio: '16:9', seconds: '12' })
      if (entry.mode === 'reference') {
        expect(body.videos).toEqual([{ url: 'https://media.example/ref.mp4', start_seconds: 0, require_audio: false }])
      }
    }
  })

  it('rejects unsupported Flash references and mixed video modes before a paid request', async () => {
    const provider = new AgnesProvider(config)
    const request = vi.spyOn(internal(provider), 'request')
    await expect(provider.submitVideoTask({
      modelId: 'agnes-video-2.5-flash',
      mode: 'video-to-video',
      prompt: 'x',
      referenceVideoUrls: ['https://media.example/ref.mp4'],
    })).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    await expect(provider.submitVideoTask({
      modelId: 'agnes-video-2.5',
      mode: 'image-to-video',
      prompt: 'x',
      firstFrameUrl: 'https://media.example/first.png',
      referenceImageUrls: ['https://media.example/ref.png'],
    })).rejects.toMatchObject({ code: 'MODE_CONFLICT' })
    await expect(provider.submitVideoTask({
      modelId: 'agnes-video-2.5-flash',
      mode: 'image-to-video',
      prompt: 'x',
      referenceImageUrls: Array.from({ length: 6 }, (_, i) => `https://media.example/${i}.png`),
    })).rejects.toMatchObject({ code: 'TOO_MANY_REFERENCES' })
    expect(request).not.toHaveBeenCalled()
  })

  it('rejects local, data and private-literal video media before a paid request', async () => {
    for (const firstFrameUrl of [
      '/api/files/key.png',
      'data:image/png;base64,x',
      'http://localhost/key.png',
      'http://127.0.0.1/key.png',
      'http://10.0.0.2/key.png',
    ]) {
      const provider = new AgnesProvider(config)
      const request = vi.spyOn(internal(provider), 'request')
      await expect(provider.submitVideoTask({
        modelId: 'agnes-video-2.5',
        mode: 'image-to-video',
        prompt: 'x',
        firstFrameUrl,
      })).rejects.toMatchObject({ code: 'PUBLIC_URL_REQUIRED' })
      expect(request).not.toHaveBeenCalled()
    }
  })

  it('queries by video_id plus model_name and maps the final top-level URL', async () => {
    const provider = new AgnesProvider(config)
    const request = vi.spyOn(internal(provider), 'request').mockResolvedValue({
      model: 'agnes-video-2.5',
      status: 'completed',
      progress: 100,
      seconds: '5',
      url: 'https://cdn.example/video.mp4',
    })
    const status = await provider.getTaskStatus('video-1', { modelId: 'agnes-video-2.5' })
    expect(request).toHaveBeenCalledWith('/agnesapi?video_id=video-1&model_name=agnes-video-2.5')
    expect(status).toMatchObject({
      status: 'completed',
      result: { videoUrls: ['https://cdn.example/video.mp4'], modelId: 'agnes-video-2.5' },
    })
  })

  it.each([
    ['queued', 'pending'],
    ['in_progress', 'processing'],
    ['failed', 'failed'],
  ])('maps Agnes task state %s to %s', async (remoteStatus, expectedStatus) => {
    const provider = new AgnesProvider(config)
    vi.spyOn(internal(provider), 'request').mockResolvedValue({
      status: remoteStatus,
      error: remoteStatus === 'failed' ? { code: 'CONTENT_BLOCKED', message: 'blocked' } : undefined,
    })

    const status = await provider.getTaskStatus('video-state', { modelId: 'agnes-video-2.5' })

    expect(status.status).toBe(expectedStatus)
    if (remoteStatus === 'failed') expect(status).toMatchObject({ error: 'blocked', errorCode: 'CONTENT_BLOCKED' })
  })
})
