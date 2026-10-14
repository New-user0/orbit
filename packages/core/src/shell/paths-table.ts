// The cmdlets whose arguments name files, with the parameters PowerShell defines for each. The tests compare this table with
// what real hosts record (test/shell-analysis/record-cmdlets.ts), so a parameter that a host adds is noticed. A name lists
// its aliases after `|`. `paths` carry the access each value gets; `leaf` is a name that must stay in one folder level;
// `sibling` is a new name for an existing item; `positional` lists the parameters in the order bare arguments bind to them.
// A parameter that is not here makes the command unvalidatable.
export type Entry = {
  paths: string[]
  leaf?: string[]
  sibling?: string[]
  switches: string
  values: string
  positional: string[]
  /** The cmdlet writes a file only when one of its path parameters is given. */
  onlyWithPath?: true
}

export const CMDLETS: Record<string, Entry> = {
  "set-content": {
    paths: ["Path write","LiteralPath|LP|PSPath write"],
    switches: "PassThru Force NoNewline AsByteStream",
    values: "Value Filter Include Exclude Credential Encoding Stream",
    positional: ["Path","Value"],
  },
  "add-content": {
    paths: ["Path write","LiteralPath|LP|PSPath write"],
    switches: "PassThru Force NoNewline AsByteStream",
    values: "Value Filter Include Exclude Credential Encoding Stream",
    positional: ["Path","Value"],
  },
  "clear-content": {
    paths: ["Path write","LiteralPath|LP|PSPath write"],
    switches: "Force",
    values: "Filter Include Exclude Credential Stream",
    positional: ["Path"],
  },
  "remove-item": {
    paths: ["Path remove","LiteralPath|LP|PSPath remove"],
    switches: "Recurse Force",
    values: "Filter Include Exclude Credential Stream",
    positional: ["Path"],
  },
  "out-file": {
    paths: ["FilePath|Path write","LiteralPath|LP|PSPath write"],
    switches: "Append Force NoClobber|NoOverwrite NoNewline",
    values: "Encoding Width InputObject",
    positional: ["FilePath","Encoding"],
  },
  "tee-object": {
    paths: ["FilePath|Path write","LiteralPath|LP|PSPath write"],
    switches: "Append",
    values: "InputObject Variable Encoding",
    positional: ["FilePath"],
  },
  "export-csv": {
    paths: ["Path write","LiteralPath|LP|PSPath write"],
    switches: "Force NoClobber|NoOverwrite Append UseCulture NoTypeInformation|NTI IncludeTypeInformation|ITI NoHeader",
    values: "InputObject Encoding Delimiter QuoteFields|QF UseQuotes|UQ",
    positional: ["Path","Delimiter"],
  },
  "export-clixml": {
    paths: ["Path write","LiteralPath|LP|PSPath write"],
    switches: "Force NoClobber|NoOverwrite",
    values: "Depth InputObject Encoding",
    positional: ["Path"],
  },
  "new-item": {
    paths: ["Path create"],
    leaf: ["Name"],
    switches: "Force",
    values: "ItemType|Type Value|Target Credential",
    positional: ["Path"],
  },
  "copy-item": {
    paths: ["Path source","LiteralPath|LP|PSPath source","Destination write"],
    switches: "Container Force Recurse PassThru",
    values: "Filter Include Exclude Credential FromSession ToSession",
    positional: ["Path","Destination"],
  },
  "move-item": {
    paths: ["Path remove","LiteralPath|LP|PSPath remove","Destination write"],
    switches: "Force PassThru",
    values: "Filter Include Exclude Credential",
    positional: ["Path","Destination"],
  },
  "rename-item": {
    paths: ["Path remove","LiteralPath|LP|PSPath remove"],
    sibling: ["NewName"],
    switches: "Force PassThru",
    values: "Credential",
    positional: ["Path","NewName"],
  },
  "set-item": {
    paths: ["Path write","LiteralPath|LP|PSPath write"],
    switches: "Force PassThru",
    values: "Value Filter Include Exclude Credential",
    positional: ["Path","Value"],
  },
  "clear-item": {
    paths: ["Path write","LiteralPath|LP|PSPath write"],
    switches: "Force",
    values: "Filter Include Exclude Credential",
    positional: ["Path"],
  },
  "set-itemproperty": {
    paths: ["Path write","LiteralPath|LP|PSPath write"],
    switches: "PassThru Force",
    values: "Name|PSProperty Value InputObject Filter Include Exclude Credential",
    positional: ["Path","Name","Value"],
  },
  "new-itemproperty": {
    paths: ["Path write","LiteralPath|LP|PSPath write"],
    switches: "Force",
    values: "Name|PSProperty PropertyType|Type Value Filter Include Exclude Credential",
    positional: ["Path","Name"],
  },
  "remove-itemproperty": {
    paths: ["Path write","LiteralPath|LP|PSPath write"],
    switches: "Force",
    values: "Name|PSProperty Filter Include Exclude Credential",
    positional: ["Path","Name"],
  },
  "export-alias": {
    paths: ["Path write","LiteralPath|LP|PSPath write"],
    switches: "PassThru Append Force NoClobber|NoOverwrite",
    values: "Name As Description Scope",
    positional: ["Path","Name"],
  },
  "expand-archive": {
    paths: ["Path write","LiteralPath|PSPath write","DestinationPath write"],
    switches: "Force PassThru",
    values: "",
    positional: ["Path","DestinationPath"],
  },
  "compress-archive": {
    paths: ["Path write","LiteralPath|PSPath write","DestinationPath write"],
    switches: "Update Force PassThru",
    values: "CompressionLevel",
    positional: ["Path","DestinationPath"],
  },
  "invoke-webrequest": {
    paths: ["InFile source","OutFile write"],
    switches: "UseBasicParsing UseDefaultCredentials DisableKeepAlive ProxyUseDefaultCredentials PassThru AllowUnencryptedAuthentication SkipCertificateCheck SkipHeaderValidation AllowInsecureRedirect PreserveAuthorizationOnRedirect PreserveHttpMethodOnRedirect NoProxy Resume SkipHttpErrorCheck",
    values: "Uri WebSession SessionVariable|SV Credential CertificateThumbprint Certificate UserAgent TimeoutSec Headers MaximumRedirection Method Proxy ProxyCredential Body ContentType TransferEncoding HttpVersion Authentication SslProtocol Token ConnectionTimeoutSeconds|TimeoutSec OperationTimeoutSeconds MaximumRetryCount RetryIntervalSec CustomMethod|CM UnixSocket Form",
    positional: ["Uri"],
    onlyWithPath: true,
  },
  "invoke-restmethod": {
    paths: ["InFile source","OutFile write"],
    switches: "UseBasicParsing UseDefaultCredentials DisableKeepAlive ProxyUseDefaultCredentials PassThru FollowRelLink|FL AllowUnencryptedAuthentication SkipCertificateCheck SkipHeaderValidation AllowInsecureRedirect PreserveAuthorizationOnRedirect PreserveHttpMethodOnRedirect NoProxy Resume SkipHttpErrorCheck",
    values: "Method Uri WebSession SessionVariable|SV Credential CertificateThumbprint Certificate UserAgent TimeoutSec Headers MaximumRedirection Proxy ProxyCredential Body ContentType TransferEncoding MaximumFollowRelLink|ML ResponseHeadersVariable|RHV StatusCodeVariable HttpVersion Authentication SslProtocol Token ConnectionTimeoutSeconds|TimeoutSec OperationTimeoutSeconds MaximumRetryCount RetryIntervalSec CustomMethod|CM UnixSocket Form",
    positional: ["Uri"],
    onlyWithPath: true,
  },
  "set-location": {
    paths: ["Path chdir","LiteralPath|LP|PSPath chdir"],
    switches: "PassThru",
    values: "StackName",
    positional: ["Path"],
  },
  "push-location": {
    paths: ["Path chdir","LiteralPath|LP|PSPath chdir"],
    switches: "PassThru",
    values: "StackName",
    positional: ["Path"],
  },
  "pop-location": {
    paths: [],
    switches: "PassThru",
    values: "StackName",
    positional: [],
  },
  "new-psdrive": {
    paths: [],
    switches: "Persist",
    values: "Name PSProvider Root Description Scope Credential",
    positional: ["Name","PSProvider","Root"],
  },
}
