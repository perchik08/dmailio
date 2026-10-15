import gif from "omggif";
import { MarketingError } from "./contracts.mjs";
const digits = {
  0: ["111", "101", "101", "101", "111"],
  1: ["010", "110", "010", "010", "111"],
  2: ["111", "001", "111", "100", "111"],
  3: ["111", "001", "111", "001", "111"],
  4: ["101", "101", "111", "001", "001"],
  5: ["111", "100", "111", "001", "111"],
  6: ["111", "100", "111", "101", "111"],
  7: ["111", "001", "010", "010", "010"],
  8: ["111", "101", "111", "101", "111"],
  9: ["111", "101", "111", "001", "111"],
  ":": ["000", "010", "000", "010", "000"],
};
export function remaining(config, now) {
  const seconds = Math.max(
    0,
    Math.floor((Date.parse(config.deadline) - now) / 1000),
  );
  return [
    Math.min(999, Math.floor(seconds / 86400)),
    Math.floor(seconds / 3600) % 24,
    Math.floor(seconds / 60) % 60,
    seconds % 60,
  ]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}
export function countdownImage(config, now) {
  const width = 330,
    height = 42,
    output = Buffer.alloc(1000000),
    palette = [
      parseInt(config.background.slice(1), 16),
      parseInt(config.foreground.slice(1), 16),
    ];
  const writer = new gif.GifWriter(output, width, height, { palette });
  // Sixty real frames: clients that only show the first frame retain a valid snapshot.
  for (let frame = 0; frame < 60; frame++) {
    const pixels = new Uint8Array(width * height),
      text = remaining(config, now + frame * 1000),
      scale = 6,
      start = Math.floor((width - text.length * 24) / 2);
    for (let i = 0; i < text.length; i++) {
      const glyph = digits[text[i]];
      for (let y = 0; y < 5; y++)
        for (let x = 0; x < 3; x++)
          if (glyph[y][x] === "1")
            for (let dy = 0; dy < scale; dy++)
              for (let dx = 0; dx < scale; dx++)
                pixels[
                  (6 + y * scale + dy) * width + start + i * 24 + x * scale + dx
                ] = 1;
    }
    writer.addFrame(0, 0, width, height, pixels, { delay: 100 });
  }
  return output.subarray(0, writer.end());
}
export class CountdownCache {
  constructor() {
    this.cache = new Map();
    this.window = 0;
    this.requests = 0;
    this.generations = 0;
  }
  get(path, now = Date.now()) {
    const match = path.match(
      /^\/marketing-countdown\/(\d{13})-([a-f\d]{6})-([a-f\d]{6})\.gif$/i,
    );
    if (!match) return null;
    const deadline = Number(match[1]);
    if (deadline < Date.UTC(2020, 0, 1) || deadline > Date.UTC(2100, 0, 1))
      return null;
    const window = Math.floor(now / 1000);
    if (this.window !== window) {
      this.window = window;
      this.requests = 0;
      this.generations = 0;
    }
    if (++this.requests > 100)
      throw new MarketingError(
        "RATE_LIMIT",
        "Слишком много запросов таймера",
        429,
      );
    const key = path + Math.floor(now / 10000);
    if (this.cache.has(key)) return this.cache.get(key);
    if (++this.generations > 5)
      throw new MarketingError("RATE_LIMIT", "Таймер временно занят", 429);
    const image = countdownImage(
      {
        deadline: new Date(deadline).toISOString(),
        foreground: "#" + match[2],
        background: "#" + match[3],
      },
      now,
    );
    if (this.cache.size >= 100)
      this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, image);
    return image;
  }
}
