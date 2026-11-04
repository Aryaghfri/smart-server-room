import dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });
import fs from "node:fs";
import { createHash } from "node:crypto";
import { settings } from "../src/lib/env";
import { parseLegacyDump } from "../src/lib/legacy-adapter";
import { saveRecords } from "../src/lib/monitoring-store";
import { closeDbs } from "../src/lib/db";

// Berkas dump hanya dibaca. DROP TABLE dan perintah SQL lain tidak pernah dieksekusi.
const filename = process.argv[2];
if (!filename)
  throw new Error('Pemakaian: npm run import:sql -- "path/iot_binus.sql"');
if (settings().mode !== "simulation")
  throw new Error("Import arsip hanya diizinkan dalam mode simulation.");
const text = fs.readFileSync(filename, "utf8");
const namespace =
  "sql:" + createHash("sha256").update(text).digest("hex").slice(0, 12);
try {
  const records = parseLegacyDump(text, namespace);
  const result = saveRecords(records, { live: false });
  console.log(
    JSON.stringify(
      {
        ...result,
        counts: Object.fromEntries(
          ["dht", "pir", "mq"].map((kind) => [
            kind,
            records.filter((r) => r.kind === kind).length,
          ]),
        ),
        note: "Histori arsip; tidak mengirim email dan tidak membuat perangkat online.",
      },
      null,
      2,
    ),
  );
} finally {
  closeDbs();
}
