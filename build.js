const fs = require("fs");
const path = require("path");

const sourceDir = path.join(__dirname, "SourceCsvs");
const files = fs.readdirSync(sourceDir).filter((f) => f.endsWith(".csv")).sort();

const languageIcons = {
  french: "\uD83C\uDDEB\uD83C\uDDF7",
  spanish: "\uD83C\uDDEA\uD83C\uDDF8",
  indonesian: "\uD83C\uDDEE\uD83C\uDDE9",
  german: "\uD83C\uDDE9\uD83C\uDDEA",
  italian: "\uD83C\uDDEE\uD83C\uDDF9",
  portuguese: "\uD83C\uDDF5\uD83C\uDDF9",
  japanese: "\uD83C\uDDEF\uD83C\uDDF5",
  chinese: "\uD83C\uDDE8\uD83C\uDDF3",
  korean: "\uD83C\uDDF0\uD83C\uDDF7",
  dutch: "\uD83C\uDDF3\uD83C\uDDF1",
  russian: "\uD83C\uDDF7\uD83C\uDDFA",
  arabic: "\uD83C\uDDF8\uD83C\uDDE6",
  thai: "\uD83C\uDDF9\uD83C\uDDED",
  vietnamese: "\uD83C\uDDFB\uD83C\uDDF3",
  hindi: "\uD83C\uDDEE\uD83C\uDDF3",
  turkish: "\uD83C\uDDF9\uD83C\uDDF7",
  swedish: "\uD83C\uDDF8\uD83C\uDDEA",
  polish: "\uD83C\uDDF5\uD83C\uDDF1",
};

const decks = files.map((f) => {
  const name = path.basename(f, ".csv");
  const id = name.toLowerCase().replace(/\s+/g, "-");
  return {
    id,
    name,
    file: "SourceCsvs/" + f,
    icon: languageIcons[id] || "\uD83D\uDCC7",
  };
});

const manifest = {
  buildTime: Date.now(),
  decks,
};

fs.writeFileSync(
  path.join(__dirname, "manifest.json"),
  JSON.stringify(manifest, null, 2)
);

console.log("Generated manifest.json with " + decks.length + " deck(s):");
decks.forEach((d) => console.log("  " + d.icon + " " + d.name + " (" + d.file + ")"));
