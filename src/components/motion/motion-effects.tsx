"use client";

import { useEffect } from "react";

import { prefersReducedMotion } from "@/lib/motion";

// Retorno de clique do protótipo DDM (motion.js), num único listener global:
//   - onda (ripple) a partir do ponto do clique em botões, abas e itens de
//     menu/lista com tamanho de controle (≥ 28×24);
//   - halo laranja (animate-ddm-glow) ao clicar switch/checkbox/radio.
// Nada disso muda layout nem estado do React: a onda é um <span> absoluto
// removido em 520ms. Com movimento reduzido, não roda.
// Elementos podem recusar com data-no-ripple (ex.: itens grandes de lista).

const RIPPLE_TARGETS =
  'button:not([data-no-ripple]),[role="tab"]:not([data-no-ripple]),[role="menuitem"]:not([data-no-ripple]),[role="option"]:not([data-no-ripple])';
const GLOW_TARGETS = '[role="switch"],[role="checkbox"],[role="radio"],[data-slot="switch"],[data-slot="checkbox"]';

function spawnRipple(event: PointerEvent) {
  const target = event.target instanceof Element ? event.target.closest<HTMLElement>(RIPPLE_TARGETS) : null;
  if (!target || target.matches(":disabled,[aria-disabled='true']")) return;
  const rect = target.getBoundingClientRect();
  if (rect.width < 28 || rect.height < 24) return;

  if (getComputedStyle(target).position === "static") target.style.position = "relative";

  // A onda vive numa camada própria recortada no formato do botão — o
  // overflow do botão não muda (selos posicionados fora continuam visíveis).
  const layer = document.createElement("span");
  layer.setAttribute("aria-hidden", "true");
  layer.style.cssText = "position:absolute;inset:0;overflow:hidden;border-radius:inherit;pointer-events:none";

  const size = Math.max(rect.width, rect.height) * 2.2;
  const ripple = document.createElement("span");
  ripple.className = "ddm-ripple";
  ripple.style.width = ripple.style.height = `${size}px`;
  ripple.style.left = `${event.clientX - rect.left - size / 2}px`;
  ripple.style.top = `${event.clientY - rect.top - size / 2}px`;
  // Sobre fundo da marca a onda é clara; nos demais, herda a cor do texto.
  if (target.classList.contains("bg-primary")) {
    ripple.style.background = "#fff";
  }
  layer.appendChild(ripple);
  target.appendChild(layer);
  window.setTimeout(() => layer.remove(), 520);
}

function glow(event: MouseEvent) {
  const el = event.target instanceof Element ? event.target.closest<HTMLElement>(GLOW_TARGETS) : null;
  if (!el) return;
  el.classList.remove("animate-ddm-glow");
  void el.offsetWidth; // reinicia a animação em cliques seguidos
  el.classList.add("animate-ddm-glow");
}

export function MotionEffects() {
  useEffect(() => {
    if (prefersReducedMotion()) return;
    document.addEventListener("pointerdown", spawnRipple, true);
    document.addEventListener("click", glow, true);
    return () => {
      document.removeEventListener("pointerdown", spawnRipple, true);
      document.removeEventListener("click", glow, true);
    };
  }, []);
  return null;
}
