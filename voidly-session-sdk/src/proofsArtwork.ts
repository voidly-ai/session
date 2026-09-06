const TITLE = "Your proof artwork";
const DESCRIPTION = "Code-generated artwork for a saved proof. Decorative, not a signed receipt or evidence of identity, payment, or impact.";
const PALETTES = [
  [[184, 166, 237], [237, 227, 206]],
  [[158, 190, 214], [224, 227, 238]],
  [[219, 185, 171], [194, 176, 230]],
];
function generator(id: string) {
  let a = parseInt(id.slice(0, 8), 16) | 0;
  let b = parseInt(id.slice(8, 16), 16) | 0;
  let c = parseInt(id.slice(16, 24), 16) | 0;
  let d = parseInt(id.slice(24, 32), 16) | 0;
  function next() {
    const value = ((a + b | 0) + d) | 0;
    d = d + 1 | 0;
    a = b ^ b >>> 9;
    b = c + (c << 3) | 0;
    c = (c << 21 | c >>> 11) + value | 0;
    return (value >>> 0) / 4294967296;
  }
  for (let index = 0; index < 16; index++) next();
  return next;
}
export function proofArtworkSvg(id: string): string {
  if (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id)) throw new Error("Artwork requires a valid saved proof event ID.");
  const random = generator(id);
  const palette = PALETTES[Math.floor(random() * PALETTES.length)];
  const rotation = random() * Math.PI * 2;
  const phase = random() * Math.PI * 2;
  const lobes = 2 + Math.floor(random() * 4);
  const twist = (random() - .5) * 4.8;
  const amplitude = .07 + random() * .12;
  const stretch = .58 + random() * .4;
  const driftX = (random() - .5) * 54;
  const driftY = (random() - .5) * 54;
  const aperture = 5 + random() * 23;
  const power = .75 + random() * .75;
  const paths: string[] = [];
  for (let ring = 0; ring < 38; ring++) {
    const progress = ring / 37;
    const radius = aperture + progress * (102 - aperture);
    const turn = rotation + twist * (1 - progress) ** 2;
    const points: string[] = [];
    for (let sample = 0; sample < 112; sample++) {
      const angle = sample / 112 * Math.PI * 2;
      const ripple = 1 + Math.sin(angle * lobes + phase + progress) * amplitude + Math.cos(angle * 2 - phase) * .025;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const x = Math.sign(cos) * Math.abs(cos) ** power * radius * ripple;
      const y = Math.sign(sin) * Math.abs(sin) ** power * radius * ripple * stretch;
      const px = 160 + Math.cos(turn) * x - Math.sin(turn) * y + driftX * (1 - progress);
      const py = 160 + Math.sin(turn) * x + Math.cos(turn) * y + driftY * (1 - progress);
      points.push(`${sample ? "L" : "M"}${px.toFixed(2)} ${py.toFixed(2)}`);
    }
    const color = palette[0].map((value, index) => Math.round(value + (palette[1][index] - value) * progress));
    paths.push(`<path d="${points.join("")}Z" fill="none" stroke="rgb(${color.join(",")})" stroke-width="${ring % 6 === 0 ? 1.4 : .9}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200" viewBox="0 0 320 320" role="img" aria-label="${TITLE}"><title>${TITLE}</title><desc>${DESCRIPTION}</desc><rect width="320" height="320" fill="#050506"/>${paths.join("")}</svg>`;
}
