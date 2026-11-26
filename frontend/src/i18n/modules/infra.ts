/** UPS & power, out-of-band control and users & roles. */
const en = {} as const;

type Keys = Record<keyof typeof en, string>;

const nl: Keys = {};
const de: Keys = {};
const es: Keys = {};
const fr: Keys = {};

export default { en, nl, de, es, fr };
