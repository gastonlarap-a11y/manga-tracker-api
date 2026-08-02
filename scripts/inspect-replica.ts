/**
 * Looks at what the off-site replica actually holds. A backup nobody can
 * inspect is not a backup, so this is the counterpart to `POST /api/sync/push`:
 * run it to confirm the cluster really has your library.
 *
 * Usage:
 *   bun run sync:inspect              # production database (mangatracker)
 *   bun run sync:inspect mangatracker_dev
 *
 * Reads MONGODB_URL from .env. Never prints the connection string — it carries
 * the cluster password.
 */
import { MongoClient } from "mongodb";

const url = Bun.env.MONGODB_URL;
if (!url) {
  console.error(
    "MONGODB_URL is not set. Add it to .env (the file is gitignored).",
  );
  process.exit(1);
}

// Defaults to production even though .env points dev elsewhere: inspecting the
// real replica is the case you actually want to be easy.
const dbName = process.argv[2] ?? "mangatracker";

const formatBytes = (bytes: number): string =>
  bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

const client = new MongoClient(url, { serverSelectionTimeoutMS: 15_000 });

try {
  await client.connect();
  const db = client.db(dbName);
  console.log(`Replica: ${dbName}\n`);

  const collections = ["mangas", "readingEvents", "siteAdapters", "covers"];
  for (const name of collections) {
    const collection = db.collection(name);
    const count = await collection.countDocuments();
    console.log(`${name.padEnd(14)} ${String(count).padStart(6)} documents`);
    if (count > 0) {
      const indexes = await collection.indexes();
      const described = indexes
        .map(
          (index) => `${index.name}${index.unique === true ? " (unique)" : ""}`,
        )
        .join(", ");
      console.log(`${" ".repeat(14)} indexes: ${described}`);
    }
  }

  // Cover bytes are the bulk of the replica and the part most worth confirming:
  // they are the copies that outlive a source site going down.
  const coverSizes = await db
    .collection("covers")
    .aggregate<{ total: number; largest: number }>([
      {
        $group: {
          _id: null,
          total: { $sum: { $binarySize: "$data" } },
          largest: { $max: { $binarySize: "$data" } },
        },
      },
    ])
    .toArray();
  const sizes = coverSizes[0];
  if (sizes) {
    console.log(
      `\nCover bytes: ${formatBytes(sizes.total)} total, largest ${formatBytes(sizes.largest)}`,
    );
  }

  const newest = await db
    .collection("readingEvents")
    .find({}, { projection: { chapterLabel: 1, readAt: 1, sourceDomain: 1 } })
    .sort({ readAt: -1 })
    .limit(3)
    .toArray();
  if (newest.length > 0) {
    console.log("\nMost recent readings in the replica:");
    for (const event of newest) {
      console.log(
        `  ${String(event.readAt)}  ${event.chapterLabel}  (${event.sourceDomain})`,
      );
    }
  }

  const sample = await db.collection("mangas").findOne({});
  if (sample) {
    console.log("\nSample manga document:");
    console.log(JSON.stringify(sample, null, 2));
  }
} catch (error) {
  console.error(
    `Could not read the replica: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
} finally {
  await client.close();
}
