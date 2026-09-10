import sharp from 'sharp';

/** sRGB -> CIELAB (D65). */
function lab(r: number, g: number, b: number) {
  const f = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 };
  const [R, G, B] = [f(r), f(g), f(b)];
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const k = (t: number) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const [fx, fy, fz] = [k(X), k(Y), k(Z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000. The perceptual distance -- 1.0 is roughly "a trained eye can just see it". */
export function deltaE(l1: number[], l2: number[]) {
  const [L1, a1, b1] = l1, [L2, a2, b2] = l2;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const A1 = (1 + G) * a1, A2 = (1 + G) * a2;
  const Cp1 = Math.hypot(A1, b1), Cp2 = Math.hypot(A2, b2);
  const h = (x: number, y: number) => { const d = Math.atan2(y, x) * 180 / Math.PI; return d < 0 ? d + 360 : d };
  const h1 = Cp1 === 0 ? 0 : h(A1, b1), h2 = Cp2 === 0 ? 0 : h(A2, b2);
  const dL = L2 - L1, dC = Cp2 - Cp1;
  let dh = 0;
  if (Cp1 * Cp2 !== 0) { dh = h2 - h1; if (dh > 180) dh -= 360; else if (dh < -180) dh += 360 }
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin(dh * Math.PI / 360);
  const Lb = (L1 + L2) / 2, Cpb = (Cp1 + Cp2) / 2;
  let hb = h1 + h2;
  if (Cp1 * Cp2 !== 0) { if (Math.abs(h1 - h2) > 180) hb += h1 + h2 < 360 ? 360 : -360; hb /= 2 } else hb = h1 + h2;
  const T = 1 - 0.17 * Math.cos((hb - 30) * Math.PI / 180) + 0.24 * Math.cos(2 * hb * Math.PI / 180)
    + 0.32 * Math.cos((3 * hb + 6) * Math.PI / 180) - 0.20 * Math.cos((4 * hb - 63) * Math.PI / 180);
  const Sl = 1 + 0.015 * (Lb - 50) ** 2 / Math.sqrt(20 + (Lb - 50) ** 2);
  const Sc = 1 + 0.045 * Cpb, Sh = 1 + 0.015 * Cpb * T;
  const Rt = -2 * Math.sqrt(Cpb ** 7 / (Cpb ** 7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((hb - 275) / 25) ** 2)) * Math.PI / 180);
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
}

const raw = (b: Buffer | string) => sharp(b).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

/** Compare two images. Returns mean/95th deltaE, SSIM on luma, and a coarse heat grid. */
export async function compare(a: Buffer | string, b: Buffer | string, grid = 16) {
  const A = await raw(a);
  const B = await sharp(b).ensureAlpha().resize(A.info.width, A.info.height, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = A.info;
  const da = A.data, db = B.data;
  const des = new Float32Array(W * H);
  const ya = new Float32Array(W * H), yb = new Float32Array(W * H);

  for (let i = 0, p = 0; i < da.length; i += 4, p++) {
    // composite over white so transparent regions compare fairly
    const c = (d: Buffer) => { const al = d[i + 3] / 255; return [d[i] * al + 255 * (1 - al), d[i + 1] * al + 255 * (1 - al), d[i + 2] * al + 255 * (1 - al)] };
    const [r1, g1, b1] = c(da), [r2, g2, b2] = c(db);
    des[p] = deltaE(lab(r1, g1, b1), lab(r2, g2, b2));
    ya[p] = 0.2126 * r1 + 0.7152 * g1 + 0.0722 * b1;
    yb[p] = 0.2126 * r2 + 0.7152 * g2 + 0.0722 * b2;
  }

  const sorted = Float32Array.from(des).sort();
  const mean = des.reduce((s, v) => s + v, 0) / des.length;
  const p95 = sorted[Math.floor(sorted.length * 0.95)];

  // global SSIM on luma (8x8 windows)
  let ssimSum = 0, wins = 0;
  const C1 = 6.5025, C2 = 58.5225;
  for (let by = 0; by + 8 <= H; by += 8) for (let bx = 0; bx + 8 <= W; bx += 8) {
    let ma = 0, mb = 0;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const p = (by + y) * W + bx + x; ma += ya[p]; mb += yb[p] }
    ma /= 64; mb /= 64;
    let va = 0, vb = 0, cov = 0;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const p = (by + y) * W + bx + x; const A1 = ya[p] - ma, B1 = yb[p] - mb; va += A1 * A1; vb += B1 * B1; cov += A1 * B1 }
    va /= 63; vb /= 63; cov /= 63;
    ssimSum += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
    wins++;
  }

  // heat grid: where the error lives
  const heat: number[][] = [];
  const cw = Math.ceil(W / grid), ch = Math.ceil(H / grid);
  for (let gy = 0; gy < grid; gy++) {
    heat.push([]);
    for (let gx = 0; gx < grid; gx++) {
      let s = 0, n = 0;
      for (let y = gy * ch; y < Math.min((gy + 1) * ch, H); y++) for (let x = gx * cw; x < Math.min((gx + 1) * cw, W); x++) { s += des[y * W + x]; n++ }
      heat[gy].push(n ? +(s / n).toFixed(2) : 0);
    }
  }

  return { width: W, height: H, meanDeltaE: +mean.toFixed(3), p95DeltaE: +p95.toFixed(3), ssim: wins ? +(ssimSum / wins).toFixed(4) : 1, heat, field: des };
}
