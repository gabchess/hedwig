(function () {
  "use strict";
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) return;

  var cells = document.querySelectorAll(".art .glow");
  for (var i = 0; i < cells.length; i++) {
    var seed = (i * 2654435761) % 6000;
    var delay = -(Math.abs(seed) % 6000) / 1000;
    cells[i].style.animationDelay = delay + "s";
  }
})();
