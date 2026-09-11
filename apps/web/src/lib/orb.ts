/**
 * Starts a decorative orb video.
 *
 * The `autoplay` attribute is not reliable across encodes — the current orb
 * never autostarts in Chromium despite being muted and fully buffered, while
 * other files of the same codec do. Calling play() explicitly works, but an
 * effect can run before the element has data, and a play() issued then is
 * dropped silently. So it is attempted immediately *and* again on `canplay`,
 * whichever comes first.
 *
 * Rejections are swallowed deliberately: a browser declining to autoplay
 * decoration is not worth surfacing, and the poster frame still shows.
 */
export function playOrb(video: HTMLVideoElement | null, reduceMotion: boolean): () => void {
  if (!video) return () => {};

  if (reduceMotion) {
    video.pause();
    return () => {};
  }

  const start = () => {
    void video.play().catch(() => {});
  };

  start();
  video.addEventListener('canplay', start);
  return () => video.removeEventListener('canplay', start);
}
