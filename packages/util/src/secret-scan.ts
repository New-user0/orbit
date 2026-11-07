/**
 * A scan for credentials, used to keep them out of team memory, which is committed with the repository and read by
 * everyone who works in it. Each rule matches a token by the distinctive prefix and shape its issuer gives it; no rule
 * looks for a keyword such as "password" next to a value, since those fire on ordinary prose. A scan names the rules
 * that fired and never returns the text that matched.
 *
 * The patterns are taken from the gitleaks rule set, version v8.30.1 (config/gitleaks.toml at commit
 * 83d9cd684c87d95d656c1458ef04895a7f1cbd8e), rewritten from Go's regular expression syntax into JavaScript's: an inline
 * case-insensitive group becomes explicit letter ranges, `\z` becomes `$`, and the entropy thresholds and keyword
 * filters that gitleaks applies around a match are not used. Three rules that gitleaks names after model vendors carry
 * neutral ids here. gitleaks is distributed under the MIT License, whose notice follows:
 *
 * MIT License
 *
 * Copyright (c) 2019 Zachary Rice
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
export * as SecretScan from "./secret-scan.js"

export interface Rule {
  readonly id: string
  readonly label: string
  readonly source: string
  readonly flags?: string
}

export interface Match {
  readonly id: string
  readonly label: string
}

// What may follow a key that gitleaks bounds on the right: a quote, a backtick, white space, a semicolon, an escaped line
// break, or the end of the text.
const END = String.raw`(?:[\x60'"\s;]|\\[nr]|$)`

const rules: ReadonlyArray<readonly [id: string, source: string, flags?: string]> = [
  ["aws-access-token", String.raw`\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\b`],
  ["gcp-api-key", String.raw`\b(AIza[\w-]{35})${END}`],
  [
    "azure-ad-client-secret",
    String.raw`(?:^|[\\'"\x60\s>=:(,)])([a-zA-Z0-9_~.]{3}\dQ~[a-zA-Z0-9_~.-]{31,34})(?:$|[\\'"\x60\s<),])`,
  ],
  ["digitalocean-pat", String.raw`\b(dop_v1_[a-f0-9]{64})${END}`],
  ["digitalocean-access-token", String.raw`\b(doo_v1_[a-f0-9]{64})${END}`],
  ["model-provider-api-key", String.raw`\b(sk-ant-api03-[a-zA-Z0-9_\-]{93}AA)${END}`],
  ["model-provider-admin-key", String.raw`\b(sk-ant-admin01-[a-zA-Z0-9_\-]{93}AA)${END}`],
  [
    "model-provider-project-key",
    String.raw`\b(sk-(?:proj|svcacct|admin)-(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})T3BlbkFJ(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})\b|sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20})${END}`,
  ],
  ["huggingface-access-token", String.raw`\b(hf_[a-zA-Z]{34})${END}`],
  ["github-pat", String.raw`ghp_[0-9a-zA-Z]{36}`],
  ["github-fine-grained-pat", String.raw`github_pat_\w{82}`],
  ["github-app-token", String.raw`(?:ghu|ghs)_[0-9a-zA-Z]{36}`],
  ["github-oauth", String.raw`gho_[0-9a-zA-Z]{36}`],
  ["github-refresh-token", String.raw`ghr_[0-9a-zA-Z]{36}`],
  ["gitlab-pat", String.raw`glpat-[\w-]{20}`],
  ["gitlab-deploy-token", String.raw`gldt-[0-9a-zA-Z_\-]{20}`],
  ["slack-bot-token", String.raw`xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*`],
  ["slack-user-token", String.raw`xox[pe](?:-[0-9]{10,13}){3}-[a-zA-Z0-9-]{28,34}`],
  ["slack-app-token", String.raw`xapp-\d-[A-Z0-9]+-\d+-[a-z0-9]+`, "i"],
  ["twilio-api-key", String.raw`SK[0-9a-fA-F]{32}`],
  ["sendgrid-api-token", String.raw`\b(SG\.[a-zA-Z0-9=_\-\.]{66})${END}`],
  ["npm-access-token", String.raw`\b(npm_[a-z0-9]{36})${END}`, "i"],
  ["pypi-upload-token", String.raw`pypi-AgEIcHlwaS5vcmc[\w-]{50,1000}`],
  ["databricks-api-token", String.raw`\b(dapi[a-f0-9]{32}(?:-\d)?)${END}`],
  ["hashicorp-tf-api-token", String.raw`[a-zA-Z0-9]{14}\.atlasv1\.[a-zA-Z0-9\-_=]{60,70}`],
  ["pulumi-api-token", String.raw`\b(pul-[a-f0-9]{40})${END}`],
  ["postman-api-token", String.raw`\b(PMAK-[a-fA-F0-9]{24}\-[a-fA-F0-9]{34})${END}`],
  ["grafana-api-key", String.raw`\b(eyJrIjoi[A-Za-z0-9]{70,400}={0,3})${END}`, "i"],
  ["grafana-cloud-api-token", String.raw`\b(glc_[A-Za-z0-9+/]{32,400}={0,3})${END}`, "i"],
  ["grafana-service-account-token", String.raw`\b(glsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8})${END}`, "i"],
  ["sentry-user-token", String.raw`\b(sntryu_[a-f0-9]{64})${END}`],
  [
    "sentry-org-token",
    String.raw`\bsntrys_eyJpYXQiO[a-zA-Z0-9+/]{10,200}(?:LCJyZWdpb25fdXJs|InJlZ2lvbl91cmwi|cmVnaW9uX3VybCI6)[a-zA-Z0-9+/]{10,200}={0,2}_[a-zA-Z0-9+/]{43}(?:[^a-zA-Z0-9+/]|$)`,
  ],
  ["stripe-access-token", String.raw`\b((?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99})${END}`],
  ["shopify-access-token", String.raw`shpat_[a-fA-F0-9]{32}`],
  ["shopify-shared-secret", String.raw`shpss_[a-fA-F0-9]{32}`],
  [
    "private-key",
    String.raw`-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S-]{64,}?KEY(?: BLOCK)?-----`,
    "i",
  ],
]

// Words of an id that are not written in title case: acronyms and names with their own capitals.
const SPELLED: Readonly<Record<string, string>> = {
  aws: "AWS",
  gcp: "GCP",
  api: "API",
  pat: "PAT",
  ad: "AD",
  tf: "TF",
  oauth: "OAuth",
  npm: "NPM",
  pypi: "PyPI",
  github: "GitHub",
  gitlab: "GitLab",
  digitalocean: "DigitalOcean",
  huggingface: "HuggingFace",
  hashicorp: "HashiCorp",
  sendgrid: "SendGrid",
}

const label = (id: string) =>
  id
    .split("-")
    .map((word) => SPELLED[word] ?? `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ")

export const RULES: readonly Rule[] = rules.map(([id, source, flags]) => ({
  id,
  label: label(id),
  source,
  ...(flags === undefined ? {} : { flags }),
}))

// Compiled on the first scan, without the global flag, so a pattern keeps no position from one call to the next.
let compiled: ReadonlyArray<readonly [Rule, RegExp]> | undefined

/** One entry per rule that matches somewhere in `text`, in the order of `RULES`, without the text that matched. */
export function scan(text: string): readonly Match[] {
  compiled ??= RULES.map((rule) => [rule, new RegExp(rule.source, rule.flags)] as const)
  return compiled.filter(([, pattern]) => pattern.test(text)).map(([rule]) => ({ id: rule.id, label: rule.label }))
}
