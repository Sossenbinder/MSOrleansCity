// Colour semantics.
//
// Colour carries meaning here, it is not decoration. Two rules:
//
//   1. Every borough has a stable hue, and every building inherits the hue of
//      the silo hosting it. When P1 kills a silo you will literally watch a
//      colour migrate across the city as grains re-activate elsewhere — that
//      migration is the lesson.
//
//   2. Vehicles are coloured by what kind of message they are, not by who sent
//      them, so the shape of a request is readable at a glance: white asks,
//      green answers, red means something was stale.

import type { EnvelopeKind } from '../sim/types';

/**
 * Distinct hues that stay legible against a dark ground.
 *
 * Amber (~35-50) is deliberately absent: it is reserved for directory offices
 * and registry traffic. A borough sharing that hue makes "is this the registry
 * or is this a grain?" unanswerable at a glance, which defeats the point of
 * colouring anything.
 */
const SILO_HUES = [205, 145, 320, 265, 175, 95];

export function siloHue(index: number): number {
  return SILO_HUES[index % SILO_HUES.length] ?? 205;
}

export function siloColorCss(index: number, lightness = 58): string {
  return `hsl(${siloHue(index)}, 68%, ${lightness}%)`;
}

/** hsl -> packed 0xRRGGBB, for three.js Color. */
export function hslHex(h: number, s: number, l: number): number {
  const sat = s / 100;
  const lig = l / 100;
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] :
    hp < 2 ? [x, c, 0] :
    hp < 3 ? [0, c, x] :
    hp < 4 ? [0, x, c] :
    hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = lig - c / 2;
  const to255 = (v: number) => Math.round(Math.min(255, Math.max(0, (v + m) * 255)));
  return (to255(r1 ?? 0) << 16) | (to255(g1 ?? 0) << 8) | to255(b1 ?? 0);
}

export function siloColor(index: number, lightness = 58): number {
  return hslHex(siloHue(index), 68, lightness);
}

export const PALETTE = {
  ground: 0x0a0e14,
  fog: 0x0a0e14,
  boroughPlate: 0x2a3746,
  boroughEdge: 0x2f3d4f,
  ringRoad: 0x35435a,
  directoryOffice: 0xc9a227,
  clientSky: 0xd8e2ef,
  text: '#dbe4f0',
  textDim: '#8b9bb0',
} as const;

/** Vehicle colour per message kind. */
export const MESSAGE_COLORS: Record<EnvelopeKind, number> = {
  'client-request': 0xbcd0e8,
  'dir-lookup': 0x6fa8ff,
  'dir-reply': 0x6fa8ff,
  'create-activation': 0xc9a227,
  'dir-register': 0xc9a227,
  'dir-register-reply': 0xc9a227,
  'activation-ready': 0xc9a227,
  'grain-request': 0xbcd0e8,
  'grain-response': 0x4bb377,
  rejection: 0xff5c5c,
  // Membership. Probes are muted — they are constant background traffic and
  // must not compete with request flow for attention. Votes are orange
  // because a vote is the moment something has actually gone wrong.
  probe: 0x7f8fa6,
  'probe-ack': 0x7f8fa6,
  'iam-alive': 0x5f708a,
  'suspect-vote': 0xff9f43,
  'membership-update': 0xd18aff,
  // Lifecycle, storage, reminders, streams.
  'dir-unregister': 0x8a7ab0,
  'grain-call-response': 0x5fd68a,
  'storage-read': 0x4fd1c5,
  'storage-read-reply': 0x4fd1c5,
  'storage-write': 0x2fb3a8,
  'storage-write-reply': 0x2fb3a8,
  'reminder-tick': 0xffd166,
  'stream-publish': 0x6ad4ff,
  'stream-deliver': 0x6ad4ff,
};

/** Vehicles that are routine background chatter, drawn smaller. */
export const MUTED_MESSAGE_KINDS: ReadonlySet<EnvelopeKind> = new Set<EnvelopeKind>([
  'probe',
  'probe-ack',
  'iam-alive',
]);

/** Plain-language label for each hop, used by the inspector and the legend. */
export const MESSAGE_LABELS: Record<EnvelopeKind, string> = {
  'client-request': 'Client call entering through a gateway',
  'dir-lookup': 'Asking the directory partition owner where the grain lives',
  'dir-reply': 'Directory answering (with an address, or nothing)',
  'create-activation': 'Zoning board telling a borough to build',
  'dir-register': 'New activation claiming the grain in the registry',
  'dir-register-reply': 'Registry resolving the claim (first writer wins)',
  'activation-ready': 'Resolved address returning to the caller',
  'grain-request': 'The call reaching the grain',
  'grain-response': 'The turn finished; answer heading back',
  rejection: 'Stale address — the grain is not here any more',
  probe: 'Health ping to a watched ring neighbour',
  'probe-ack': 'Ping answered — the neighbour is up',
  'iam-alive': 'Silo stamping its own row in the membership table',
  'suspect-vote': 'A watcher filing a suspicion vote against a peer',
  'membership-update': 'Membership change gossiped to the surviving silos',
  'dir-unregister': 'Collected grain removing itself from the directory',
  'grain-call-response': 'Answer returning to the grain that was waiting',
  'storage-read': 'Loading grain state as part of activation',
  'storage-read-reply': 'State loaded from the vault',
  'storage-write': 'Writing grain state back, under an ETag',
  'storage-write-reply': 'Write accepted, or rejected as stale',
  'reminder-tick': 'Durable reminder firing — this will activate the grain',
  'stream-publish': 'Producer pushing an event to its pulling agent',
  'stream-deliver': 'Pulling agent fanning an event out to a subscriber',
};
