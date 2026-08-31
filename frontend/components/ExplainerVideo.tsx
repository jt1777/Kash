'use client';

/** Skip the opening white hold (S1 title FadeIn is 2s). */
const START_AT_S = 2;

export function ExplainerVideo() {
  return (
    <video
      controls
      playsInline
      preload="metadata"
      aria-label="How KASH works"
      src={`/KASH-explainer-FINAL-1080p60.mp4#t=${START_AT_S}`}
      onLoadedMetadata={(e) => {
        const video = e.currentTarget;
        if (video.currentTime < START_AT_S) video.currentTime = START_AT_S;
      }}
    />
  );
}
