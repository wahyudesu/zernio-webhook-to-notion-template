import crypto from "node:crypto";
import fs from "node:fs";
const env = Object.fromEntries(fs.readFileSync(".env","utf8").split("\n").filter(Boolean).map(l=>[l.split("=")[0],l.slice(l.indexOf("=")+1)]));
const body = JSON.stringify({
  id: "evt_test_local_1", event: "message.received", timestamp: new Date().toISOString(),
  message: { id: "msg_test_1", conversationId: "conv_test_1", platform: "instagram", direction: "incoming",
    text: "Hi, is this still available?", sender: { id: "17841400000000000", name: "Jane", username: "jane_doe" } },
  conversation: { id: "conv_test_1", status: "active" },
  account: { id: "acc_test_1", accountId: "acc_test_1", profileId: "prof_test_1", platform: "instagram" },
  profiles: [{ id: "prof_test_1", externalId: "cus_test" }]
});
const sig = crypto.createHmac("sha256", env.ZERNIO_WEBHOOK_SECRET).update(body).digest("hex");
const url = `http://127.0.0.1:${env.PORT}/webhooks/zernio`;
const post = (signature) => fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-zernio-signature": signature }, body });
console.log("bad sig ->", (await post("deadbeef")).status);
console.log("good sig ->", (await post(sig)).status, await (await post(sig)).text());
console.log("health ->", await (await fetch(`http://127.0.0.1:${env.PORT}/health`)).text());
