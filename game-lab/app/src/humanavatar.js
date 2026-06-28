// humanavatar.js — instantiate the shared human glTF onto a rig, auto-scaled + oriented +
// tinted, with a weapon in the right hand. Used by the player (controller.js) and enemies
// (enemies.js) so scale/facing/gun/tint are tuned in ONE place.
//
// IMPORTANT: the glTF import's root node (`__root__`) carries Babylon's unit + handedness
// conversion. We must NOT overwrite its transform (doing so sinks/mis-scales the model). So we
// wrap the import in our OWN holder node and transform the holder; the import stays untouched.
//
// Auto-scale: the model is sized to `targetHeight` from its world bounding box, so it can never
// come in "tiny" regardless of the source model's native units. Feet drop to the parent origin.

import { TransformNode } from "@babylonjs/core/Meshes/transformNode";

// ── The one knob for character prominence ────────────────────────────────────────
// World-height (units) of the player + every enemy. Bigger = characters read larger /
// more prominent against the city (the ergoudan feel). 1.85 ≈ real human; bump for presence.
export const HUMAN_HEIGHT = 2.4;

const RIGHT_HAND_RE = /(mixamorig.*RightHand|RightHand|hand.*r\b|wrist.*r\b|arm_joint_R__3_)/i;

function worldYExtent(node) {
  let minY = Infinity, maxY = -Infinity;
  for (const m of node.getChildMeshes(false)) {
    if (!m.getBoundingInfo) continue;
    m.computeWorldMatrix(true);
    const bb = m.getBoundingInfo().boundingBox;
    if (bb.minimumWorld.y < minY) minY = bb.minimumWorld.y;
    if (bb.maximumWorld.y > maxY) maxY = bb.maximumWorld.y;
  }
  if (!isFinite(minY)) return { minY: 0, maxY: 1, h: 1 };
  return { minY, maxY, h: Math.max(1e-3, maxY - minY) };
}

// asset: shared AssetContainer (ctx.humanAsset). parent: the rig's TransformNode (root).
// opts: { targetHeight, faceYaw, gun (mesh→right hand), gunOffset, tint (Color3) }
export function spawnHuman(asset, parent, Vector3, opts = {}) {
  const { targetHeight = HUMAN_HEIGHT, faceYaw = 0, gun = null, gunOffset = null, tint = null } = opts;
  const scene = parent.getScene();
  // Clone materials per-instance only when we need a per-character tint (else share for perf).
  const inst = asset.instantiateModelsToScene(undefined, !!tint);
  const imported = inst.rootNodes[0]; // __root__ — KEEP its import transform intact

  // Our control node. We scale/rotate/position THIS, leaving the import's conversion alone.
  const holder = new TransformNode("rr_human_holder", scene);
  imported.parent = holder;
  holder.rotation = new Vector3(0, faceYaw, 0);
  holder.scaling.setAll(1);
  holder.position.setAll(0);
  holder.computeWorldMatrix(true);

  // Measure at identity, scale to target height, then drop feet to the parent origin.
  const ext = worldYExtent(holder);
  const s = targetHeight / ext.h;
  holder.scaling.setAll(s);
  holder.parent = parent;
  holder.position.set(0, -ext.minY * s, 0);

  // Per-character tint (enemy tier color / player emerald) on the cloned materials.
  if (tint) {
    for (const m of holder.getChildMeshes(false)) {
      const mat = m.material;
      if (!mat) continue;
      if (mat.albedoColor) mat.albedoColor = tint.clone();        // PBRMaterial (glTF default)
      else if (mat.diffuseColor) mat.diffuseColor = tint.clone(); // StandardMaterial
    }
  }

  // Locomotion clips by NAME (X Bot: idle/run/jump/fall/Climbing); fall back to the lone clip.
  const groups = inst.animationGroups || [];
  const idle = groups.find((g) => /idle|stand/i.test(g.name || "")) || null;
  const move = groups.find((g) => /run|walk|jog/i.test(g.name || "")) || groups[0] || null;
  for (const g of groups) g.stop();
  if (idle) idle.start(true);
  if (move) { move.start(true); move.pause(); }

  // Gun into the right-hand bone (counter-scale by 1/s so it stays world-sized in bone space).
  const skel = (inst.skeletons && inst.skeletons[0]) || null;
  if (gun && skel && skel.bones.length) {
    const hand = skel.bones.find((b) => RIGHT_HAND_RE.test(b.name || ""))
      || skel.bones.find((b) => /(right|_R\b)/i.test(b.name || ""))
      || skel.bones[skel.bones.length - 1];
    if (hand) {
      gun.parent = null;
      gun.attachToBone(hand, holder);
      gun.scaling.setAll(1 / s);
      gun.position.copyFrom(gunOffset || new Vector3(0, 0, 0));
    }
  }

  const footY = -ext.minY * s; // world feet offset at root.scaling == 1
  return {
    inst, holder, idle, move, skel, scale: s, footY,
    // Keep the human at an ABSOLUTE height (and feet on the ground) regardless of the rig
    // root's scaling — so every enemy is the same size as the player, not scaled by ent.size.
    fitTo(rootScale) {
      const r = rootScale || 1;
      holder.scaling.setAll(s / r);
      holder.position.y = footY / r;
    },
    setMoving(on, speed = 1) {
      if (on) {
        if (idle) idle.pause();
        if (move) { move.play(true); move.speedRatio = Math.min(2.4, 0.8 + speed * 0.2); }
      } else {
        if (move) move.pause();
        if (idle) idle.play(true);
      }
    },
    setEnabled(on) { holder.setEnabled(on); },
    dispose() { try { inst.dispose(); } catch { /* noop */ } },
  };
}
