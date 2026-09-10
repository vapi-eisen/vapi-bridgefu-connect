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
        for key in ("engineer", "stages", "client_cidr", "area_code", "agent_auto_accept", "connect_alias", "passphrase"):
            self.assertIn(key, inputs)
        self.assertEqual(inputs["stages"]["options"], ["phone", "full"])
        steps = [step.get("name", step.get("uses", "")) for step in data["jobs"]["provision"]["steps"]]
        order = [steps.index(name) for name in ("Restore saved state", "Preflight", "Stage 1 Amazon Connect", "Stage 2 Bridgefu", "Stage 3 Vapi wiring", "Stage 5 browser path", "Save state", "Write the handout")]
        self.assertEqual(order, sorted(order))
        save = next(step for step in data["jobs"]["provision"]["steps"] if step.get("name") == "Save state")
        self.assertEqual(save["if"], "always()")
        self.assertIn("lab-${{ inputs.engineer }}", data["concurrency"]["group"])

    def test_teardown_forgets_state_only_on_success(self):
        data = load("lab-teardown.yml")
        steps = {step.get("name"): step for step in data["jobs"]["teardown"]["steps"] if step.get("name")}
        self.assertIn("state delete", steps["Forget the lab"]["run"])
        self.assertEqual(steps["Keep partial state for a retry"]["if"], "failure()")
        self.assertIn("--keep-vapi-secret", steps["Teardown"]["run"])

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
        sids = {s["Sid"] for s in role["Policies"][0]["PolicyDocument"]["Statement"]}
        self.assertTrue({"LabStacks", "LabIamRoles", "LabSecrets", "LabBuckets", "Dns", "HostCommands"} <= sids)


if __name__ == "__main__":
    unittest.main()
