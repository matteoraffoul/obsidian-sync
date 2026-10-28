import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { Users } from "./auth.js";
import { backupData } from "./backup.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { VERSION } from "./version.js";

const USAGE = `Usage:
  user add <username> [--admin] [--password <password>]
  user passwd <username> [--password <password>]
  user remove <username>
  user list
  backup <target-dir>
  version

Without --password you are prompted for it (input hidden).
backup is safe while the server runs; repeating it into the same folder only copies new files.`;

async function promptPassword(): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const question = async (label: string) => {
    const answer = rl.question(label);
    muted = true;
    const value = await answer;
    muted = false;
    process.stdout.write("\n");
    return value;
  };
  try {
    const password = await question("Password: ");
    const again = await question("Repeat password: ");
    if (password !== again) throw new Error("Passwords do not match");
    return password;
  } finally {
    rl.close();
  }
}

async function main(argv: string[]): Promise<void> {
  const [group, command, username] = argv;
  if (group === "version") {
    console.log(VERSION);
    return;
  }
  if (group === "backup") {
    if (!command) throw new Error(USAGE);
    const config = loadConfig();
    const db = openDb(config.dataDir);
    try {
      const target = path.resolve(command);
      const { blobsCopied } = await backupData(db, config.dataDir, target);
      console.log(`Backup written to ${target} (${blobsCopied} new blobs)`);
    } finally {
      db.close();
    }
    return;
  }
  const flag = (name: string) => argv.includes(name);
  const option = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  if (group !== "user" || !command) throw new Error(USAGE);

  const db = openDb(loadConfig().dataDir);
  const users = new Users(db);
  try {
    switch (command) {
      case "list":
        for (const user of users.list()) console.log(`${user.username}\t${user.role}`);
        return;
      case "add": {
        if (!username) throw new Error(USAGE);
        const password = option("--password") ?? (await promptPassword());
        const user = users.create(username, password, flag("--admin") ? "admin" : "user");
        console.log(`Created ${user.role} "${user.username}"`);
        return;
      }
      case "passwd": {
        if (!username) throw new Error(USAGE);
        users.setPassword(username, option("--password") ?? (await promptPassword()));
        console.log(`Password changed for "${username}" (existing sessions logged out)`);
        return;
      }
      case "remove":
        if (!username) throw new Error(USAGE);
        users.remove(username);
        console.log(`Removed "${username}"`);
        return;
      default:
        throw new Error(USAGE);
    }
  } finally {
    db.close();
  }
}

main(process.argv.slice(2)).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
