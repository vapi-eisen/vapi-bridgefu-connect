import unittest

from _support import ROOT, load_cfn


class RunnerStackTests(unittest.TestCase):
    def setUp(self):
        self.template = load_cfn(ROOT / "iam" / "lab-runner.yaml")
        self.resources = self.template["Resources"]

    def test_nothing_runs_in_github_actions(self):
        self.assertFalse((ROOT / ".github" / "workflows").exists(), "remote mode runs in CodeBuild; no workflows")
        self.assertNotIn("GitHubOidcProvider", self.resources)
        self.assertNotIn("token.actions.githubusercontent.com", str(self.template))

    def test_runner_role_is_codebuild_only_and_bounded(self):
        role = self.resources["RunnerRole"]["Properties"]
        statement = role["AssumeRolePolicyDocument"]["Statement"][0]
        self.assertEqual(statement["Principal"], {"Service": "codebuild.amazonaws.com"})
        self.assertEqual(statement["Action"], "sts:AssumeRole")
        self.assertIn("project/${RoleName}", str(statement["Condition"]["ArnLike"]["aws:SourceArn"]))
        self.assertEqual(role["PermissionsBoundary"], {"Ref": "LabPolicy"}, "the runner must be bounded by the lab policy")
        project = self.resources["RunnerProject"]["Properties"]
        self.assertIn("RunnerRole", str(project["ServiceRole"]))
        self.assertIn("node scripts/lab.mjs runner", project["Source"]["BuildSpec"])
        self.assertIn("nodejs: 22", project["Source"]["BuildSpec"])

    def test_guardrails(self):
        statements = self.resources["LabPolicy"]["Properties"]["PolicyDocument"]["Statement"]
        sids = {s["Sid"] for s in statements}
        self.assertTrue({"LabStacks", "LabIamRoles", "LabSecrets", "LabBuckets", "LabZoneRecords", "HostCommands"} <= sids)
        denies = {s["Sid"] for s in statements if s["Effect"] == "Deny"}
        self.assertTrue({"DenyOutsideLabRegions", "DenyLargeInstances", "DenyHumanCredentials", "DenyTouchingTheSandboxItself"} <= denies)
        inline = self.resources["RunnerRole"]["Properties"]["Policies"][0]["PolicyDocument"]["Statement"]
        self.assertEqual({s["Sid"] for s in inline if s["Effect"] == "Deny"}, {"DenyTouchingTheGateway", "DenyRewritingGatewayObjects"})
        self.assertIn("LabHostedZone", self.resources)
        budget = self.resources["LabBudget"]["Properties"]["Budget"]
        self.assertEqual(budget["BudgetName"], "bridgefu-lab-monthly")
        self.assertIn("CostFilters", budget, "the budget must be scoped to the lab's Project tag, not the whole account")
        self.assertNotIn("VapiSecret", self.resources, "no shared Vapi key secret: engineers bring their own")
        wrap_key = self.resources["WrapKey"]["Properties"]
        self.assertEqual(wrap_key["KeySpec"], "RSA_3072")
        self.assertEqual(wrap_key["KeyUsage"], "ENCRYPT_DECRYPT")

    def test_gateway_is_a_public_url_with_a_narrow_role(self):
        url = self.resources["GatewayUrl"]["Properties"]
        self.assertEqual(url["AuthType"], "NONE", "GitHub repository access is checked inside the function")
        actions = {self.resources[name]["Properties"]["Action"] for name in ("GatewayUrlPermission", "GatewayUrlInvokePermission")}
        self.assertEqual(actions, {"lambda:InvokeFunctionUrl", "lambda:InvokeFunction"})
        self.assertTrue(self.resources["GatewayUrlInvokePermission"]["Properties"]["InvokedViaFunctionUrl"])
        policy = self.resources["GatewayRole"]["Properties"]["Policies"][0]["PolicyDocument"]["Statement"]
        allowed = {action for s in policy for action in ([s["Action"]] if isinstance(s["Action"], str) else s["Action"])}
        self.assertEqual(allowed, {"codebuild:StartBuild", "codebuild:BatchGetBuilds", "logs:GetLogEvents", "s3:GetObject", "s3:ListBucket", "s3:PutObject", "kms:GetPublicKey"})
        env = self.resources["GatewayFunction"]["Properties"]["Environment"]["Variables"]
        self.assertEqual(env["LAB_REPO"], {"Ref": "LabRepository"})
        self.assertEqual(self.resources["ReaperSchedule"]["Properties"]["Targets"][0]["Input"], '{"action":"reap"}')

    def test_job_outputs_expire(self):
        rules = {rule["Id"]: rule for rule in self.resources["StateBucket"]["Properties"]["LifecycleConfiguration"]["Rules"]}
        self.assertEqual(rules["expire-job-outputs"]["Prefix"], "jobs/")
        self.assertEqual(rules["expire-job-outputs"]["ExpirationInDays"], 2, "handouts carry the encrypted agent password")


if __name__ == "__main__":
    unittest.main()
