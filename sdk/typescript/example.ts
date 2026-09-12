// Runs against a live Airlock:  node --experimental-strip-types sdk/typescript/example.ts
import { Airlock, ActionDenied } from "./airlock.ts";

const airlock = new Airlock();
const lease = await airlock.createLease({ issueId: "AIR-103", agent: "ts-agent", writeSet: ["auth/session"] });
console.log(`lease ${lease.id} rev ${lease.revision} watching ${Object.keys(lease.watches).join(", ")}`);

const openPr = airlock.guarded(lease.id, "open-pr", ["auth/session"], async () => "PR opened");
try {
  console.log(await openPr());
} catch (error) {
  if (error instanceof ActionDenied) console.log(error.decision.code, Airlock.failing(error.decision)?.detail);
  else throw error;
}
await airlock.release(lease.id);
