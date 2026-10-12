(() => {
  "use strict";

  const box = document.getElementById("video");
  const play = document.getElementById("video-play");
  if (!box || !play) return;

  play.addEventListener("click", () => {
    const frame = document.createElement("iframe");
    frame.src =
      "https://www.youtube-nocookie.com/embed/" +
      encodeURIComponent(box.dataset.id) +
      "?autoplay=1";
    frame.title = "Gabe on why he builds Hedwig";
    frame.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    frame.allowFullscreen = true;
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    box.replaceChildren(frame);
    frame.focus();
  });
})();
