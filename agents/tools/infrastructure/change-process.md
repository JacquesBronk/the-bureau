# Infrastructure Change Process
> Structured process for making infrastructure changes safely — CI/CD, containers, IaC, deployments.

## When to Use
Load this tool before making any infrastructure change: pipeline modifications, Dockerfile updates, Terraform/IaC changes, deployment configuration, or environment/secrets management.

## Process

### 1. Assess — Classify the Change

Determine the change category and risk level:

| Category | Examples | Risk |
|----------|----------|------|
| CI/CD Pipeline | Workflow files, build steps, test stages | Medium — broken pipeline blocks all deploys |
| Container | Dockerfile, Compose, image tags, registries | Medium — bad image breaks runtime |
| IaC | Terraform, Ansible, Pulumi, CloudFormation | High — can destroy or misconfigure resources |
| Deployment | Deploy scripts, manifests, rollout config | High — direct production impact |
| Secrets/Config | Env vars, vault paths, config maps | High — wrong secrets = outage or data exposure |

High-risk changes require explicit approval before applying.

### 2. Plan — Define Before and After

Before writing any configuration:
- Document the **current state** (read the existing config, don't assume)
- Document the **desired state** (what should change and why)
- Document the **rollback procedure** (how to return to current state)
- Identify **blast radius** (what systems/services are affected)

For IaC changes: always run the plan/preview command first (`terraform plan`, `pulumi preview`, etc.) and review the diff before applying.

### 3. Validate — Pre-Flight Checks

Run these checks before applying any change:

**CI/CD changes:**
- Lint the workflow file (YAML syntax, valid action references)
- Check that referenced secrets exist in the target environment
- Verify that step dependencies are correct (needs, depends_on)
- Confirm the trigger conditions are intentional (push, PR, schedule, manual)

**Container changes:**
- Build the image locally — it must succeed
- Verify the image starts and passes health checks
- Check for unnecessary layers, large base images, or files that shouldn't be in the image
- Confirm no secrets are baked into the image (no COPY of .env, no ARG for passwords)

**IaC changes:**
- Run plan/preview — review every resource that will be created, modified, or destroyed
- Flag any resource destruction and confirm it's intentional
- Check for state drift (has the live infrastructure diverged from the config?)
- Verify provider versions and module pinning

**Deployment changes:**
- Confirm CI is green — never deploy on a red build
- Verify all required environment variables and secrets are available in the target
- Confirm the rollback mechanism works (can you actually roll back?)
- If the change requires downtime, confirm the maintenance window is communicated

**Secrets/Config changes:**
- Verify the secret exists in the target secret store (not just locally)
- Confirm the reference format matches what the runtime expects
- Never log, print, or echo secret values — even in debug mode

### 4. Apply — Make the Change

- Use declarative configuration over imperative scripts wherever possible
- Make one logical change per commit — don't bundle unrelated infra changes
- Tag or version the change so it can be referenced during rollback
- For IaC: apply with the exact plan you reviewed (not a fresh plan)

### 5. Verify — Confirm Success

After applying:
- Check that the service/pipeline/resource is in the expected state
- Run a smoke test or health check against the deployed change
- Verify logs show normal startup and operation
- Confirm monitoring and alerting are active for the changed component

### 6. Document — Record What Changed

Every infrastructure change must produce:
- **What changed** and why
- **How to test locally** (commands to reproduce/verify)
- **How to roll back** (exact steps, not "revert the commit")
- **New dependencies** (secrets, services, tools required)

## Iron Law
Never apply an infrastructure change you haven't validated locally or in a preview. "It should work" is not validation — run the plan, build the image, lint the config.

## Red Flags
- "I'll add the rollback plan later" — STOP. Rollback is defined before apply, not after.
- "CI is red but my change is unrelated" — STOP. Red CI means no deploys. Fix CI first or confirm the failure is truly unrelated by reading the logs.
- "I'll just push this secret temporarily" — STOP. Secrets in version control are permanent. Use a secret store.
- "Terraform wants to destroy this resource but it's probably fine" — STOP. Read the plan. Understand why. Get approval if the destruction is unexpected.
- "I'll test it in production" — STOP. Test locally or in staging first. Production is not a test environment.

## Example

**Task:** Add a Docker health check to an existing service.

**Good approach:**
1. Read the existing Dockerfile and Compose config
2. Identify the health endpoint (or note its absence)
3. Add HEALTHCHECK to Dockerfile with appropriate interval/timeout/retries
4. Build locally, verify container reports healthy
5. Update Compose with healthcheck override if needed
6. Document: what changed, how to test (`docker inspect --format='{{.State.Health}}'`), rollback (revert HEALTHCHECK line)

**Bad approach:**
- Copy a HEALTHCHECK from another project without reading what endpoint it hits
- Push without building locally
- Skip documenting the rollback
