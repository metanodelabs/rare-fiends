// The bytes that mark a one-of-one, written down in ONE place because a signature freezes them.
//
// THE PRINCIPLE, and it is wider than this one trait: **we follow the collection's metadata and do not
// invent our own shape for it.** The deployer settled it in as many words - *"because the metadata calls
// the category evolution and that is fine.. we follow the metadata."* So the key is `Evolution` because
// Doopies' JSON says `Evolution`, not because `Evolution` is the word we would have picked; the same rule
// decides the next collection and the next field.
//
// THE TENSION, recorded here rather than discovered later: **we follow the metadata, but our signatures
// freeze it.** The key and the value below go inside the EIP-712 hash of every claim the attestor signs
// (`ShadowFriends.Claim.traitKeys` / `traitValues`), so if Doopies ever renamed the trait, every signature
// already issued would still be looking for `Evolution` - and `ShadowFriends` has no upgrade path. That is
// why nothing here canonicalises quietly: a spelling we did not expect **stops the attestor** (see
// `oneOfOne` below) instead of being folded into the one we did.
//
// WHY THESE BYTES AND NOT OTHERS - looked up off Solana, not decided. `Evolution` is one slot used two
// ways: an ordinary Doopie's reads `Evolution 1` … `Evolution 4`, which stage it is at; a one-of-one's
// reads `1/1` instead of a stage. Five values in one field, and no competing rarity field anywhere in the
// collection - 75 of 75 one-of-ones across 4,194 tokens read. `1/1` is three ASCII characters: one,
// solidus, one. No spaces, no `of`, no `#`.
//
// Read by the bridge page (the `1/1` badge) and by the attestor (what it signs), so the two cannot drift.
'use strict';

/** The trait that says which evolution a Doopie is at - and, for a one-of-one, that it is one. */
export const TRAIT_KEY = 'Evolution';

/** The value that marks a one-of-one. Three characters. */
export const ONE_OF_ONE = '1/1';

/** The four ordinary values, for completeness: this is the same slot, used for a stage. */
export const STAGES = ['Evolution 1', 'Evolution 2', 'Evolution 3', 'Evolution 4'];

/** What `ShadowFriends.claim` will not exceed (`MAX_TRAITS`), so the attestor never signs a refused claim. */
export const MAX_TRAITS = 32;

/**
 * A short string right-padded into 32 bytes, which is the only spelling that round-trips: the contract's
 * `_b32` reads a `bytes32` back as text by stopping at the first zero byte, so padding on the right is
 * invisible and padding on the left is not.
 */
export function b32(s) {
  const bytes = new TextEncoder().encode(String(s));
  if (bytes.length === 0) throw new Error('a trait key or value cannot be empty: the contract refuses BadTraitKey');
  if (bytes.length > 32) throw new Error('does not fit in bytes32 (' + bytes.length + ' bytes): ' + s);
  let hex = '0x';
  for (let i = 0; i < 32; i++) hex += (bytes[i] || 0).toString(16).padStart(2, '0');
  return hex;
}

/** The other direction: a `bytes32` read back as text, stopping at the first zero byte, as `_b32` does. */
export function unb32(h) {
  const hex = String(h).replace(/^0x/, '');
  const out = [];
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const b = parseInt(hex.slice(i, i + 2), 16);
    if (b === 0) break;
    out.push(b);
  }
  return new TextDecoder().decode(new Uint8Array(out));
}

export const KEY_B32 = b32(TRAIT_KEY);
export const ONE_OF_ONE_B32 = b32(ONE_OF_ONE);

/** Is this a list of `{ trait_type, value }` the way a Metaplex `attributes` array is? */
const looksLikeAttributes = (a) => Array.isArray(a) && a.every((x) => x && typeof x === 'object');

/**
 * The `Evolution` trait, by its exact bytes. `exact` is the only reading the attestor may act on; `loose`
 * is what a case-insensitive match found, and it exists so a refusal can SAY what the spelling was.
 */
export function readEvolution(attributes) {
  if (!looksLikeAttributes(attributes)) return { exact: null, loose: null };
  const exact = attributes.find((a) => a.trait_type === TRAIT_KEY) || null;
  const loose = attributes.find((a) => String(a.trait_type || '').toLowerCase() === TRAIT_KEY.toLowerCase()) || null;
  return { exact, loose };
}

/**
 * THE TRI-STATE, and it is the whole of M21 item 9: **"could not read it" is never "not a one-of-one."**
 *
 * Returns `{ ok, oneOfOne, reason }`. `ok === false` means REFUSE TO SIGN - never "ordinary Doopie".
 * A Doopie's traits are not on chain: they live in off-chain JSON behind an `ar://` uri whose gateway
 * 302-redirects and rate-limits hard (429 after roughly four thousand reads). A slow gateway that
 * silently answered "not a one-of-one" would downgrade the rarest tokens in the collection **and nothing
 * on screen would look wrong**, which is why this returns three answers and not two.
 *
 * `ok === false` for a MISSING or MISSPELLED `Evolution` as well as for an unread one, and that is
 * deliberate: this collection carries the trait on every one of its 4,194 tokens, so its absence means
 * our assumption about the collection has broken, not that the token is ordinary. Refusing is recoverable
 * - a signature is not.
 */
export function oneOfOne(attributes) {
  if (attributes === null || attributes === undefined) {
    return { ok: false, oneOfOne: null, reason: 'the metadata was not read: nothing is signed' };
  }
  if (!looksLikeAttributes(attributes)) {
    return { ok: false, oneOfOne: null, reason: 'the metadata carried no attributes list: nothing is signed' };
  }
  const { exact, loose } = readEvolution(attributes);
  if (!exact && loose) {
    return { ok: false, oneOfOne: null,
      reason: 'the metadata spells the trait "' + loose.trait_type + '" and every signature we have issued says "'
        + TRAIT_KEY + '": nothing is signed' };
  }
  if (!exact) {
    return { ok: false, oneOfOne: null,
      reason: 'the metadata has no "' + TRAIT_KEY + '" trait, which this collection carries on every token: nothing is signed' };
  }
  const value = String(exact.value);
  return { ok: true, oneOfOne: value === ONE_OF_ONE, reason: TRAIT_KEY + ' = ' + value };
}

/**
 * What the badge on a card should say. The bug this replaces (`estate/bridge.html`, the shelf's card) was
 * `.find()` over `/evolution|species/i`, and **`Species` is listed before `Evolution` on every one-of-one**
 * - so the one token whose rarity you would most want shown was the one showing something else.
 * Cosmetic, and the cosmetic is the point: it is the badge's whole job.
 */
export function badge(attributes) {
  const r = oneOfOne(attributes);
  if (r.ok && r.oneOfOne) return { text: ONE_OF_ONE, rare: true };
  const { exact } = readEvolution(attributes);
  if (exact) return { text: String(exact.value), rare: false };
  const species = looksLikeAttributes(attributes)
    ? attributes.find((a) => /^species$/i.test(String(a.trait_type || ''))) : null;
  return { text: species ? String(species.value) : '', rare: false };
}

/**
 * The metadata's attributes as the two `bytes32` arrays a claim carries, canonicalised **by rejection
 * rather than by rewriting**: the contract compares keys byte for byte and refuses a duplicate, an
 * all-zero key and more than `MAX_TRAITS`, so anything that would be refused is refused here first -
 * where a refusal costs nothing instead of costing a signature recovery.
 * Throws rather than dropping a trait: a claim carrying fewer traits than the token has is a claim that
 * quietly says something false about it.
 */
export function canonicalTraits(attributes) {
  if (!looksLikeAttributes(attributes)) throw new Error('no attributes to canonicalise');
  const keys = [], values = [], seen = new Set();
  for (const a of attributes) {
    const k = String(a.trait_type === undefined || a.trait_type === null ? '' : a.trait_type);
    const v = String(a.value === undefined || a.value === null ? '' : a.value);
    if (!k) throw new Error('a trait with no name: the contract refuses BadTraitKey');
    if (!v) throw new Error('trait "' + k + '" has no value');
    const kb = b32(k);                       // throws if it does not fit in 32 bytes
    if (seen.has(kb)) throw new Error('the trait "' + k + '" appears twice: the contract refuses DuplicateTrait');
    seen.add(kb);
    keys.push(kb);
    values.push(b32(v));
  }
  if (keys.length > MAX_TRAITS) throw new Error(keys.length + ' traits: the contract refuses TooManyTraits over ' + MAX_TRAITS);
  return { keys, values };
}
