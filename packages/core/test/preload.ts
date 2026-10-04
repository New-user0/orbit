process.env.ORBIT_DB = ":memory:"
process.env.NPM_CONFIG_AUDIT = "false"
// Tests write project config next to the code under test, so the default node graph trusts every folder. Trust
// behavior is covered where a test builds WorkspaceTrust with `implicit: false`.
process.env.ORBIT_TRUST_PROJECT = "1"
