import assert from "node:assert/strict";
import test from "node:test";
import { labRecordsToDelete } from "../../scripts/lib/teardown.mjs";

const HOST = "bridgefu-lab.example.com";
const RECORDS = [
  { Name: "example.com.", Type: "NS" },
  { Name: "example.com.", Type: "SOA" },
  { Name: "example.com.", Type: "A", TTL: 300 },
  { Name: "bridgefu-lab.example.com.", Type: "A", TTL: 60, ResourceRecords: [{ Value: "203.0.113.10" }] },
  { Name: "_a1b2c3.bridgefu-lab.example.com.", Type: "CNAME", TTL: 300, ResourceRecords: [{ Value: "_x.acm-validations.aws." }] },
  { Name: "_d4e5f6.control.bridgefu-lab.example.com.", Type: "CNAME", TTL: 300, ResourceRecords: [{ Value: "_y.acm-validations.aws." }] },
  { Name: "control.bridgefu-lab.example.com.", Type: "A", TTL: 60 },
  { Name: "bridgefu-lab.example.com.other.example.com.", Type: "A", TTL: 60 },
  { Name: "notbridgefu-lab.example.com.", Type: "A", TTL: 60 },
  { Name: "www.example.com.", Type: "CNAME", TTL: 300 },
];

test("selects only records under the lab hostname and never the apex, NS, or SOA", () => {
  const names = labRecordsToDelete(RECORDS, HOST).map((r) => `${r.Type} ${r.Name}`);
  assert.deepEqual(names, [
    "A bridgefu-lab.example.com.",
    "CNAME _a1b2c3.bridgefu-lab.example.com.",
    "CNAME _d4e5f6.control.bridgefu-lab.example.com.",
    "A control.bridgefu-lab.example.com.",
  ]);
});

test("is case-insensitive and tolerates a trailing dot on the hostname", () => {
  assert.equal(labRecordsToDelete([{ Name: "_X.BRIDGEFU-LAB.EXAMPLE.COM.", Type: "CNAME" }], "Bridgefu-Lab.example.com.").length, 1);
  assert.equal(labRecordsToDelete([], HOST).length, 0);
});
