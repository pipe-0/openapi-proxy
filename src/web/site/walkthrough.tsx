const VIDEO_ID = "vecJ1G2AAv0";
/** YouTube's player that sets no cookies until it is played. The page's policy allows this origin in frames. */
export const PLAYER_ORIGIN = "https://www.youtube-nocookie.com";

/** The walkthrough, in YouTube's own player, where the editor is first shown. */
export function Walkthrough() {
  return (
    <section className="mx-auto max-w-6xl px-4 sm:px-6" aria-label="Walkthrough">
      <div className="overflow-hidden rounded-xl bg-card shadow-float ring-1 ring-border">
        <iframe
          src={`${PLAYER_ORIGIN}/embed/${VIDEO_ID}?rel=0`}
          title="openapi-proxy walkthrough"
          loading="lazy"
          allow="encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
          className="block aspect-video h-auto w-full"
        />
      </div>
    </section>
  );
}
