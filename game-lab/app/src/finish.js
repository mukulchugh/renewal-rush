// finish.js — the WIN finish line. Replaces the "churned exit" framing with a Times Square
// plaza: bright flanking billboards + a giant QUIVLY screen on the end tower. A glowing marker
// sits on the boulevard at the finish — when the player reaches it, the run is WON.
//
// Self-contained + additive: builds its own geometry past the play bounds (z > gate) and runs
// ONE onFrame win-check off ctx.state.playerPos. No world.js / enemies.js coupling.

import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";

const FINISH_Z = 374;  // marker on the boulevard — inside the player's reachable bounds (maxZ ~382)
const PLAZA_Z = 410;   // Times Square backdrop, just past the Renewal Gate

export function createFinish(ctx) {
  const { scene, onFrame, state, bus, game } = ctx;
  const emerald = Color3.FromHexString("#34D399");

  const emis = (name, color, alpha = 1) => {
    const m = new StandardMaterial(name, scene);
    m.disableLighting = true; m.backFaceCulling = false;
    m.diffuseColor = new Color3(0, 0, 0); m.specularColor = new Color3(0, 0, 0);
    m.emissiveColor = color; if (alpha < 1) m.alpha = alpha;
    return m;
  };

  // Daylight skyscraper facade — LIT glass/steel with a window grid (NOT emissive, so it won't
  // bloom to white under the bright sky). Reads like the city's buildings.
  const facadeMat = new StandardMaterial("finish_facade_m", scene);
  facadeMat.diffuseTexture = facadeTexture(scene);
  facadeMat.specularColor = new Color3(0.22, 0.27, 0.33); // glassy sheen
  facadeMat.emissiveColor = new Color3(0.05, 0.06, 0.08);  // faint fill so shadow sides aren't pure black

  // ── End tower with the giant QUIVLY screen (faces the approaching player) ────
  const tower = MeshBuilder.CreateBox("finish_tower", { width: 72, height: 156, depth: 34 }, scene);
  tower.position.set(0, 78, PLAZA_Z); tower.material = facadeMat; tower.isPickable = false;

  // LED panel backing + the real Quivly logo (public/models/quivly-logo.png).
  const back = MeshBuilder.CreatePlane("finish_screen_bg", { width: 58, height: 36 }, scene);
  back.position.set(0, 74, PLAZA_Z - 17.2); back.rotation.y = Math.PI; // face -Z (toward player)
  back.material = emis("finish_screen_bgm", Color3.FromHexString("#04140d")); back.isPickable = false;

  const logoTex = new Texture("/models/quivly-logo.png", scene);
  logoTex.hasAlpha = true; logoTex.uScale = -1; logoTex.uOffset = 1; // un-mirror after the 180° flip
  const logoMat = emis("finish_logo_m", new Color3(0.86, 1.0, 0.93));
  logoMat.emissiveTexture = logoTex; logoMat.opacityTexture = logoTex;
  const logo = MeshBuilder.CreatePlane("finish_logo", { width: 48, height: 12 }, scene); // ~logo 4:1 aspect
  logo.position.set(0, 74, PLAZA_Z - 17.4); logo.rotation.y = Math.PI;
  logo.material = logoMat; logo.isPickable = false;

  // ── Times Square flanking towers + varied AD screens (the busy billboard wall) ──
  const ads = [
    adTexture(scene, "#F43F5E", "#fff", "CHURN", "DOWN 42%"),
    adTexture(scene, "#3B82F6", "#fff", "RENEW", "every 90s"),
    adTexture(scene, "#FBBF24", "#1a1205", "ARR", "BANKED"),
    adTexture(scene, "#A855F7", "#fff", "DEPLOY", "agents live"),
    adTexture(scene, "#22D3EE", "#04222a", "SIGNAL", "intercept"),
    adTexture(scene, "#10B981", "#03251a", "HEALTH", "100%"),
  ].map((t) => { const m = emis("finish_ad", new Color3(1, 1, 1)); m.emissiveTexture = t; return m; });

  for (let i = 0; i < 8; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const bx = side * (46 + (i % 3) * 18);
    const bz = PLAZA_Z - 44 + (i % 4) * 22;
    const h = 56 + (i % 3) * 44;
    const b = MeshBuilder.CreateBox("finish_blk_" + i, { width: 26, height: h, depth: 24 }, scene);
    b.position.set(bx, h / 2, bz); b.material = facadeMat; b.isPickable = false;
    // Two stacked ad screens on each tower's boulevard-facing inner side → Times-Square density.
    const ax = bx - side * 13.2, ry = side * Math.PI / 2;
    const bb = MeshBuilder.CreatePlane("finish_bb_" + i, { width: 22, height: 14 }, scene);
    bb.position.set(ax, h * 0.64, bz); bb.rotation.y = ry; bb.material = ads[i % ads.length]; bb.isPickable = false;
    const bb2 = MeshBuilder.CreatePlane("finish_bb2_" + i, { width: 22, height: 12 }, scene);
    bb2.position.set(ax, h * 0.34, bz); bb2.rotation.y = ry; bb2.material = ads[(i + 3) % ads.length]; bb2.isPickable = false;
  }

  // ── Finish marker on the boulevard: ring + light beam + floating label ───────
  const ringMat = emis("finish_ring_m", emerald);
  const ring = MeshBuilder.CreateTorus("finish_ring", { diameter: 9, thickness: 0.5, tessellation: 32 }, scene);
  ring.position.set(0, 0.4, FINISH_Z); ring.rotation.x = Math.PI / 2; ring.material = ringMat; ring.isPickable = false;

  const beam = MeshBuilder.CreateCylinder("finish_beam", { height: 130, diameter: 7, tessellation: 24 }, scene);
  beam.position.set(0, 65, FINISH_Z); beam.material = emis("finish_beam_m", emerald, 0.1); beam.isPickable = false;

  const labTex = new DynamicTexture("finish_label", { width: 512, height: 128 }, scene, true);
  { const g = labTex.getContext(); g.clearRect(0, 0, 512, 128);
    g.font = "bold 60px system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillStyle = "#34D399"; g.fillText("RENEW HERE", 256, 70); labTex.update(); labTex.hasAlpha = true; }
  const labMat = emis("finish_label_m", new Color3(1, 1, 1));
  labMat.emissiveTexture = labTex; labMat.opacityTexture = labTex;
  const label = MeshBuilder.CreatePlane("finish_label_p", { width: 16, height: 4 }, scene);
  label.position.set(0, 8, FINISH_Z); label.billboardMode = 2; label.material = labMat; label.isPickable = false;

  // ── Win trigger: reach the marker → bank the renewal + fire the win flow ─────
  let won = false, t = 0;
  onFrame((dt) => {
    t += dt;
    const pulse = 0.55 + 0.45 * Math.sin(t * 3);
    ringMat.emissiveColor.copyFrom(emerald).scaleInPlace(pulse);
    ring.rotation.y = t * 0.6;
    if (won || !state.running || state.paused) return;
    const p = state.playerPos;
    if (p && p.z >= FINISH_Z - 3 && Math.abs(p.x) < 16) {
      won = true;
      if (game) game.wonRenewal = true;
      state.running = false;
      bus.emit("win");
    }
  });
}

// Daytime glass/steel facade: steel base + a grid of glass windows (some reflective). LIT (used
// as a diffuseTexture), so it reads as a real skyscraper under the sky, not a glowing white slab.
// Math.random is fine here: one-time decorative texture, not gameplay (outside the seeded RNG).
function facadeTexture(scene) {
  const W = 256, H = 512, t = new DynamicTexture("finish_facade", { width: W, height: H }, scene, true);
  const g = t.getContext();
  g.fillStyle = "#39434f"; g.fillRect(0, 0, W, H); // steel mullions
  const cols = 7, rows = 16, cw = W / cols, ch = H / rows, pad = 4;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const v = 0.55 + Math.random() * 0.4;
    g.fillStyle = Math.random() < 0.28
      ? "#a9cdec" // bright reflective glass
      : `rgb(${Math.round(46 * v)},${Math.round(64 * v)},${Math.round(86 * v)})`; // blue-tinted glass
    g.fillRect(c * cw + pad, r * ch + pad, cw - 2 * pad, ch - 2 * pad);
  }
  t.update();
  t.uScale = 3; t.vScale = 6; // tile so windows stay small across the tall facades
  return t;
}

// A bright fake "ad" panel (Times Square variety) — bold title + subline on a brand color.
function adTexture(scene, bg, fg, title, sub) {
  const S = 256, H = 154, t = new DynamicTexture("finish_ad_t", { width: S, height: H }, scene, true);
  const g = t.getContext();
  g.fillStyle = bg; g.fillRect(0, 0, S, H);
  g.fillStyle = fg; g.textAlign = "center";
  g.font = "bold 58px system-ui, sans-serif"; g.textBaseline = "middle";
  g.fillText(title, S / 2, H * 0.4);
  g.font = "600 26px system-ui, sans-serif";
  g.fillText(sub, S / 2, H * 0.74);
  t.update();
  return t;
}
