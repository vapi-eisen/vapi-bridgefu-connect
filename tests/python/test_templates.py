import re
import shutil
import subprocess
import unittest

from _support import ROOT, load_cfn

TEMPLATES = [ROOT / "cloudformation" / "connect-lab.yaml", ROOT / "cloudformation" / "lab-web.yaml", ROOT / "iam" / "lab-runner.yaml"]


def load(path):
    return load_cfn(path)


class TemplateTests(unittest.TestCase):
    def test_cfn_lint_is_clean(self):
        if shutil.which("cfn-lint") is None:
            self.skipTest("cfn-lint not installed")
        completed = subprocess.run(["cfn-lint", *map(str, TEMPLATES)], capture_output=True, text=True, check=False)
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)

    def test_connect_lab_grants_the_screen_pop_view_permissions(self):
        template = load(TEMPLATES[0])
        permissions = template["Resources"]["LabAgentSecurityProfile"]["Properties"]["Permissions"]
        self.assertEqual(set(permissions), {"BasicAgentAccess", "CustomViews.Access", "Views.View"})
        self.assertEqual(template["Resources"]["LabAgent"]["Properties"]["PhoneConfig"]["PhoneType"], "SOFT_PHONE")
        for output in ("ConnectInstanceArn", "TargetContactFlowArn", "ConnectLoginUrl", "AgentCredentialSecretArn", "ConnectAlias"):
            self.assertIn(output, template["Outputs"])
        alias = template["Parameters"]["InstanceAlias"]
        self.assertEqual(alias["Default"], "")
        self.assertIn("UseDefaultAlias", template["Conditions"])

    def test_lab_web_reuses_the_released_handoff_contract(self):
        template = load(TEMPLATES[1])
        resources = template["Resources"]
        self.assertEqual(resources["DirectHandoffRoute"]["Properties"]["RouteKey"], "POST /v1/direct-handoff")
        self.assertEqual(resources["DirectSessionRoute"]["Properties"]["RouteKey"], "POST /v1/direct-session")
        env = resources["DirectHandoffFunction"]["Properties"]["Environment"]["Variables"]
        self.assertEqual(
            set(env),
            {
                "HANDOFF_TABLE_NAME", "VAPI_WEBHOOK_SECRET_ARN", "VAPI_IDENTITY_BINDING_ARN", "BRIDGEFU_API_BEARER_SECRET_ARN",
                "BRIDGEFU_CONTROL_BASE_URL", "DIRECT_HANDOFF_SIGNING_KEY_SECRET_ARN", "DIRECT_HANDOFF_ROUTE_ID",
                "SCREEN_POP_FIELDS_JSON", "DEPLOYMENT_ID", "SIP_SECURITY",
            },
        )
        self.assertEqual(env["DIRECT_HANDOFF_ROUTE_ID"], "amazon-connect")
        code = resources["DirectHandoffFunction"]["Properties"]["Code"]
        self.assertEqual(code["S3Bucket"], {"Ref": "ReleaseArtifactBucket"})
        self.assertEqual(code["S3ObjectVersion"], {"Ref": "TransferArtifactVersion"})
        self.assertEqual(resources["DirectHandoffFunction"]["Properties"]["Handler"], "handler.lambda_handler")
        ingress = resources["WssIngress"]["Properties"]
        self.assertEqual(ingress["CidrIp"], {"Ref": "LabClientCidr"})
        self.assertEqual(ingress["FromPort"], {"Ref": "WssPort"})
        self.assertEqual({r["Properties"]["CidrIp"] for r in (resources["VapiTlsEgress1"], resources["VapiTlsEgress2"])}, {"44.229.228.186/32", "44.238.177.138/32"})
        session_env = resources["DirectSessionFunction"]["Properties"]["Environment"]["Variables"]
        self.assertEqual(session_env["DIRECT_ROUTE_ID"], "vapi-direct-assistant")
        self.assertEqual(session_env["CONNECT_ROUTE_ID"], "amazon-connect")

    def test_templates_contain_no_literal_secrets(self):
        for path in TEMPLATES:
            text = path.read_text(encoding="utf-8")
            self.assertIsNone(re.search(r"(?i)(sk_live|api[_-]?key\s*:\s*['\"]?[A-Za-z0-9]{20,})", text), path.name)


if __name__ == "__main__":
    unittest.main()
