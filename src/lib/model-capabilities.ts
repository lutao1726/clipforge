import type { GenAspectRatio, GenResolution } from "@/lib/gen-params";
import { videoSize } from "@/lib/gen-params";
import {
  getVideoParamSpec,
  pickEnumDuration,
  pickRatio,
  pickResolution,
} from "@/lib/providers/atlas-video-params";
import { modelSupportsLastFrame } from "@/lib/video-composer/transitions";

export type CapabilityConfidence = "known" | "inferred" | "unknown";

export interface VideoModelCapabilities {
  confidence: CapabilityConfidence;
  textToVideo: boolean | null;
  imageToVideo: boolean | null;
  referenceImages: boolean | null;
  referenceVideo: boolean | null;
  referenceAudio: boolean | null;
  lastFrame: boolean | null;
  nativeAudio: boolean | null;
  /** Accepts an existing video as an editing/conditioning source. */
  videoEdit: boolean | null;
  /** Accepts an explicit time window for provider-native partial regeneration. */
  temporalRetake: boolean | null;
  /** Accepts a spatial mask/region for provider-native inpainting. */
  regionMask: boolean | null;
  /** Accepts keyframes with native timeline positions rather than unordered references. */
  multiKeyframes: boolean | null;
  /** Can use a reference video to guide body motion or performance. */
  performanceReference: boolean | null;
  durationValues?: number[];
  resolutionValues?: string[];
  aspectRatioValues?: string[];
  maxReferenceImages?: number;
}

function advancedCapabilities(
  modelId: string,
  referenceVideo: boolean | null,
  referenceImages: boolean | null,
  provider?: string,
): Pick<VideoModelCapabilities, "videoEdit" | "temporalRetake" | "regionMask" | "multiKeyframes" | "performanceReference"> {
  const id = modelId.toLowerCase();
  const seedanceEdit = /seedance-2\.0/.test(id) && (referenceVideo === true || provider === "volcengine");
  const known = referenceVideo !== null || referenceImages !== null;
  return {
    videoEdit: seedanceEdit ? true : referenceVideo === true ? false : referenceVideo,
    // Current provider request schemas do not expose native time ranges, masks, or
    // timeline-positioned keyframes. Local retake/splice and ordered references are
    // negotiated separately, so the UI never overstates provider-native precision.
    temporalRetake: known ? false : null,
    regionMask: known ? false : null,
    multiKeyframes: known ? false : null,
    performanceReference: referenceVideo,
  };
}

export interface PreflightAdjustment {
  field: "duration" | "resolution" | "aspectRatio" | "chainMode";
  requested: string | number;
  effective: string | number;
  code: "nearest-duration" | "mapped-resolution" | "adaptive-ratio" | "unsupported-last-frame";
}

export interface VideoGenerationPreflight {
  capabilities: VideoModelCapabilities;
  adjustments: PreflightAdjustment[];
  warnings: Array<
    | "capabilities-unknown"
    | "native-audio-unavailable"
    | "reference-images-trimmed"
    | "reference-conditioning-unavailable"
    | "reference-audio-unavailable"
    | "public-media-url-required"
  >;
}

function isClearlyPublicHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host === "::1" || host.endsWith(".local")) return false;
    if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return false;
    const private172 = /^172\.(\d{1,3})\./.exec(host);
    if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return false;
    if (/^(?:fc|fd)[0-9a-f]{2}:/i.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

function referenceSibling(modelId: string): string | undefined {
  if (/\/reference-to-video$/.test(modelId)) return modelId;
  const sibling = modelId.replace(/\/(?:text|image)-to-video$/, "/reference-to-video");
  if (sibling === modelId) return undefined;
  if (getVideoParamSpec(sibling)?.referenceShape) return sibling;
  // Older catalog families use the same endpoint naming but predate schema-backed specs.
  if (/^bytedance\/seedance-2\.0\/reference-to-video$/.test(sibling)) return sibling;
  return undefined;
}

function referenceCapabilities(modelId: string, provider?: string): Pick<VideoModelCapabilities, "referenceImages" | "referenceVideo" | "referenceAudio" | "maxReferenceImages"> {
  const sibling = referenceSibling(modelId);
  const spec = sibling ? getVideoParamSpec(sibling) : undefined;
  const arkMultimodal = provider === "volcengine" && /seedance|doubao/i.test(modelId);
  const referenceKnown = Boolean(sibling || spec?.referenceShape || arkMultimodal);
  const referenceAudio = arkMultimodal || /(?:minimax\/h3|bytedance\/seedance-2\.(?:0|5))/.test(sibling ?? modelId);
  const explicitReferenceMode = inferredModes(modelId).referenceVideo;
  return {
    referenceImages: referenceKnown ? true : explicitReferenceMode !== null ? false : null,
    referenceVideo: referenceKnown ? true : explicitReferenceMode !== null ? false : null,
    referenceAudio: referenceKnown ? referenceAudio : explicitReferenceMode !== null ? false : null,
    ...(spec?.maxReferenceImages != null && { maxReferenceImages: spec.maxReferenceImages }),
  };
}

function inferredModes(modelId: string): Pick<VideoModelCapabilities, "textToVideo" | "imageToVideo" | "referenceVideo"> {
  const id = modelId.toLowerCase();
  const explicit = /(?:text-to-video|\/t2v(?:-|$))/.test(id)
    ? "text"
    : /(?:image-to-video|\/i2v(?:-|$)|start-end-to-video)/.test(id)
      ? "image"
      : /reference-to-video/.test(id)
        ? "reference"
        : null;
  if (!explicit) return { textToVideo: null, imageToVideo: null, referenceVideo: null };
  return {
    textToVideo: explicit === "text",
    imageToVideo: explicit === "image",
    referenceVideo: explicit === "reference",
  };
}

function agnesCapabilities(modelId: string, provider?: string): VideoModelCapabilities | undefined {
  const isAgnes = provider === "agnes" || /^agnes-video-2\.5(?:-flash)?$/i.test(modelId);
  if (!isAgnes) return undefined;
  const flash = /-flash$/i.test(modelId);
  return {
    confidence: "known",
    textToVideo: true,
    imageToVideo: true,
    referenceImages: true,
    referenceVideo: !flash,
    referenceAudio: true,
    lastFrame: true,
    nativeAudio: true,
    videoEdit: false,
    temporalRetake: false,
    regionMask: false,
    multiKeyframes: false,
    performanceReference: !flash,
    durationValues: [4, 5, 6, 7, 8, 9, 10, 11, 12],
    resolutionValues: ["720p"],
    aspectRatioValues: ["9:16", "16:9", "1:1"],
    ...(flash && { maxReferenceImages: 5 }),
  };
}

/** Normalize provider-specific video metadata into one UI-facing capability contract. */
export function getVideoModelCapabilities(modelId: string, supportsAudio?: boolean, provider?: string): VideoModelCapabilities {
  const agnes = agnesCapabilities(modelId, provider);
  if (agnes) return agnes;
  const spec = getVideoParamSpec(modelId);
  const modes = inferredModes(modelId);
  const references = referenceCapabilities(modelId, provider);
  if (!spec) {
    const hasInference = Object.values(modes).some((value) => value !== null);
    const advanced = advancedCapabilities(modelId, references.referenceVideo, references.referenceImages, provider);
    return {
      confidence: hasInference || supportsAudio !== undefined ? "inferred" : "unknown",
      ...modes,
      ...references,
      // An allowlist hit proves support; a miss on an unknown/custom model proves nothing.
      lastFrame: modelId && modelSupportsLastFrame(modelId) ? true : null,
      nativeAudio: supportsAudio ?? null,
      ...advanced,
    };
  }

  const advanced = advancedCapabilities(modelId, references.referenceVideo, references.referenceImages, provider);
  return {
    confidence: "known",
    ...modes,
    ...references,
    referenceAudio: references.referenceAudio ?? false,
    lastFrame: Boolean(spec.lastFrameKey),
    // H3 creates stereo audio without exposing an on/off field.
    nativeAudio: supportsAudio ?? (Boolean(spec.audioKey) || /minimax\/h3\//.test(modelId)),
    ...advanced,
    durationValues: spec.durationEnum,
    resolutionValues: spec.resolutionEnum,
    aspectRatioValues: spec.ratioEnum,
    maxReferenceImages: references.maxReferenceImages ?? spec.maxReferenceImages,
  };
}

/**
 * Preview the exact compatibility mapping already performed by the provider adapter.
 * Unknown custom models stay permissive: they receive one informational warning and no blocking rewrite.
 */
export function preflightVideoGeneration(input: {
  modelId: string;
  provider?: string;
  supportsAudio?: boolean;
  duration?: number;
  resolution: GenResolution;
  aspectRatio: GenAspectRatio;
  chainMode: "pin" | "tail" | "off";
  audioEnabled?: boolean;
  referenceImageCount?: number;
  referenceAudioCount?: number;
  mediaUrls?: string[];
}): VideoGenerationPreflight {
  const capabilities = getVideoModelCapabilities(input.modelId, input.supportsAudio, input.provider);
  const spec = getVideoParamSpec(input.modelId);
  const adjustments: PreflightAdjustment[] = [];
  const warnings: VideoGenerationPreflight["warnings"] = [];

  const agnes = agnesCapabilities(input.modelId, input.provider);
  if (agnes) {
    if (input.duration != null) {
      const effective = Math.max(4, Math.min(12, Math.round(input.duration)));
      if (effective !== input.duration) {
        adjustments.push({ field: "duration", requested: input.duration, effective, code: "nearest-duration" });
      }
    }
    if (input.resolution !== "720p") {
      adjustments.push({ field: "resolution", requested: input.resolution, effective: "720p", code: "mapped-resolution" });
    }
    if ((input.referenceImageCount ?? 0) > 0 && agnes.referenceImages === false) warnings.push("reference-conditioning-unavailable");
    if ((input.referenceAudioCount ?? 0) > 0 && agnes.referenceAudio === false) warnings.push("reference-audio-unavailable");
    if (agnes.maxReferenceImages != null && (input.referenceImageCount ?? 0) > agnes.maxReferenceImages) {
      warnings.push("reference-images-trimmed");
    }
    if (input.mediaUrls?.some((url) => !isClearlyPublicHttpUrl(url))) {
      warnings.push("public-media-url-required");
    }
    return { capabilities, adjustments, warnings };
  }

  if (!spec) {
    if (capabilities.confidence === "unknown") warnings.push("capabilities-unknown");
    if (input.audioEnabled && capabilities.nativeAudio === false) warnings.push("native-audio-unavailable");
    if ((input.referenceImageCount ?? 0) > 0 && capabilities.referenceImages === false) warnings.push("reference-conditioning-unavailable");
    if ((input.referenceAudioCount ?? 0) > 0 && capabilities.referenceAudio === false) warnings.push("reference-audio-unavailable");
    return { capabilities, adjustments, warnings };
  }

  const { width, height } = videoSize(input.resolution, input.aspectRatio);
  if (input.duration != null && spec.durationEnum) {
    const effective = pickEnumDuration(spec.durationEnum, input.duration);
    if (effective != null && effective !== input.duration) {
      adjustments.push({ field: "duration", requested: input.duration, effective, code: "nearest-duration" });
    }
  }
  if (spec.resolutionEnum) {
    const effective = pickResolution(spec.resolutionEnum, width, height);
    if (effective && effective.toLowerCase() !== input.resolution.toLowerCase()) {
      adjustments.push({ field: "resolution", requested: input.resolution, effective, code: "mapped-resolution" });
    }
  }
  if (spec.ratioEnum) {
    const effective = pickRatio(spec.ratioEnum, width, height);
    if (effective && effective !== input.aspectRatio) {
      adjustments.push({ field: "aspectRatio", requested: input.aspectRatio, effective, code: "adaptive-ratio" });
    }
  }
  if (input.chainMode !== "off" && !spec.lastFrameKey) {
    adjustments.push({ field: "chainMode", requested: input.chainMode, effective: "off", code: "unsupported-last-frame" });
  }
  if (input.audioEnabled && capabilities.nativeAudio === false) warnings.push("native-audio-unavailable");
  if ((input.referenceImageCount ?? 0) > 0 && capabilities.referenceImages === false) warnings.push("reference-conditioning-unavailable");
  if ((input.referenceAudioCount ?? 0) > 0 && capabilities.referenceAudio === false) warnings.push("reference-audio-unavailable");
  if (capabilities.maxReferenceImages != null && (input.referenceImageCount ?? 0) > capabilities.maxReferenceImages) {
    warnings.push("reference-images-trimmed");
  }
  return { capabilities, adjustments, warnings };
}
