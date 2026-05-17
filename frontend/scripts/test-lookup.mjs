import { readFileSync } from "fs";

const src = readFileSync("src/lib/data/airport-db.ts", "utf-8");
const re = /\["([^"]+)",\{n:"([^"]*)",ia:"([^"]*)",ic:"([^"]*)"/g;
const map = new Map();
let m;
while ((m = re.exec(src)) !== null) {
  map.set(m[1], { name: m[2], iata: m[3], icao: m[4] });
}

console.log(`Total entries in map: ${map.size}\n`);

const tests = [
  "VIDP",
  "VABB",
  "VOBL",
  "VOCI",
  "VECC",
  "VOHS",
  "VEJT",
  "VAAH",
  "VAGO",
  "VIAG",
  "VIAR",
  "VIBR",
  "KJFK",
  "EGLL",
  "OMDB",
  "WSSS",
  "LFPG",
  "RJTT",
];

for (const code of tests) {
  const entry = map.get(code);
  if (entry) {
    console.log(`✓ ${code} → ${entry.name} (${entry.iata || "no IATA"})`);
  } else {
    console.log(`✗ ${code} → NOT FOUND`);
  }
}
