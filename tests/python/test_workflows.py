import unittest

import yaml
from _support import ROOT, load_cfn

WORKFLOWS = ROOT / ".github" / "workflows"


def load(name):
    data = yaml.safe_load((WORKFLOWS / name).read_text(encoding="utf-8"))
    # PyYAML parses the bare `on:` key as boolean True.
    data["on"] = data.get("on", data.get(True))
    return data


class WorkflowTests(unittest.TestCase):
    def test_every_lab_workflow_uses_oidc_and_repository_variables(self):
        for name in ("lab-provision.yml", "lab-verify.yml", "lab-teardown.yml", "lab-reaper.yml"):
            data = load(name)
            self.assertEqual(data["permissions"]["id-token"], "write", name)
            self.assertEqual(data["permissions"]["contents"], "read", name)
            text = (WORKFLOWS / name).read_text(encoding="utf-8")
            self.assertIn("aws-actions/configure-aws-credentials@v4", text, name)
            self.assertIn("vars.AWS_LAB_ROLE_ARN", text, name)
            self.assertNotIn("AWS_ACCESS_KEY_ID", text, name)
            self.assertNotIn("AWS_SECRET_ACCESS_KEY", text, name)

    def test_provision_inputs_and_stage_order(self):
        data = load("lab-provision.yml")
        inputs = data["on"]["workflow_dispatch"]["inputs"]
        for key in ("engineer", "vapi_key_wrapped", "stages", "client_cidr", "area_code", "agent_auto_accept", "connect_alias", "handout_public_key", "passphrase"):
            self.assertIn(key, inputs)
        self.assertTrue(inputs["vapi_key_wrapped"]["required"], "every provision needs the engineer's wrapped key")
        text = (WORKFLOWS / "lab-provision.yml").read_text(encoding="utf-8")
        self.assertNotIn("LAB_VAPI_SECRET_ARN", text, "no shared Vapi key anymore")
        self.assertIn("vars.LAB_WRAP_KEY_ARN", text)
        self.assertEqual(inputs["stages"]["options"], ["phone", "full"])
        steps = [step.get("name", step.get("uses", "")) for step in data["jobs"]["provision"]["steps"]]
        order = [steps.index(name) for name in ("Restore saved state", "Unwrap the Vapi key into this lab's secret", "Preflight", "Stage 1 Amazon Connect", "Stage 2 Bridgefu", "Stage 3 Vapi wiring", "Stage 5 browser path", "Save state", "Write the handout")]
        self.assertEqual(order, sorted(order))
        save = next(step for step in data["jobs"]["provision"]["steps"] if step.get("name") == "Save state")
        self.assertEqual(save["if"], "always()")
        self.assertIn("lab-${{ inputs.engineer }}", data["concurrency"]["group"])

    def test_verify_publishes_the_report_as_an_artifact(self):
        text = (WORKFLOWS / "lab-verify.yml").read_text(encoding="utf-8")
        self.assertIn("actions/upload-artifact@v4", text)
        self.assertIn("lab-verify-${{ inputs.engineer }}-${{ inputs.mode }}", text)

    def test_teardown_forgets_state_only_on_success(self):
        data = load("lab-teardown.yml")
        steps = {step.get("name"): step for step in data["jobs"]["teardown"]["steps"] if step.get("name")}
        self.assertIn("state delete", steps["Forget the lab"]["run"])
        self.assertEqual(steps["Keep partial state for a retry"]["if"], "failure()")
        self.assertNotIn("--keep-vapi-secret", steps["Teardown"]["run"], "the per-engineer key secret goes with the lab")

    def test_reaper_is_scheduled(self):
        data = load("lab-reaper.yml")
        self.assertIn("schedule", data["on"])
        self.assertIn("reap --bucket", data["jobs"]["reap"]["steps"][-1]["run"])

    def test_ci_runs_make_check(self):
        data = load("ci.yml")
        runs = [step.get("run", "") for step in data["jobs"]["check"]["steps"]]
        self.assertIn("make check", runs)


class RunnerTemplateTests(unittest.TestCase):
    def test_runner_role_trusts_only_the_repository(self):
        template = load_cfn(ROOT / "iam" / "lab-runner.yaml")
        role = template["Resources"]["RunnerRole"]["Properties"]
        statement = role["AssumeRolePolicyDocument"]["Statement"][0]
        self.assertEqual(statement["Action"], "sts:AssumeRoleWithWebIdentity")
        self.assertEqual(statement["Condition"]["StringEquals"]["token.actions.githubusercontent.com:aud"], "sts.amazonaws.com")
        self.assertIn("repo:${GitHubRepository}:${GitHubRefSuffix}", str(statement["Condition"]["StringLike"]))
        self.assertEqual(role["PermissionsBoundary"], {"Ref": "LabPolicy"}, "the runner must be bounded by the lab policy")
        statements = template["Resources"]["LabPolicy"]["Properties"]["PolicyDocument"]["Statement"]
        sids = {s["Sid"] for s in statements}
        self.assertTrue({"LabStacks", "LabIamRoles", "LabSecrets", "LabBuckets", "LabZoneRecords", "HostCommands"} <= sids)
        denies = {s["Sid"] for s in statements if s["Effect"] == "Deny"}
        self.assertTrue({"DenyOutsideLabRegions", "DenyLargeInstances", "DenyHumanCredentials", "DenyTouchingTheSandboxItself"} <= denies)
        self.assertIn("LabHostedZone", template["Resources"])
        budget = template["Resources"]["LabBudget"]["Properties"]["Budget"]
        self.assertEqual(budget["BudgetName"], "bridgefu-lab-monthly")
        self.assertIn("CostFilters", budget, "the budget must be scoped to the lab's Project tag, not the whole account")
        self.assertNotIn("VapiSecret", template["Resources"], "no shared Vapi key secret: engineers bring their own")
        wrap_key = template["Resources"]["WrapKey"]["Properties"]
        self.assertEqual(wrap_key["KeySpec"], "RSA_3072")
        self.assertEqual(wrap_key["KeyUsage"], "ENCRYPT_DECRYPT")
        variables = str(template["Outputs"]["GitHubVariables"]["Value"])
        self.assertIn("LAB_WRAP_KEY_ARN", variables)
        self.assertNotIn("LAB_VAPI_SECRET_ARN", variables)


if __name__ == "__main__":
    unittest.main()
