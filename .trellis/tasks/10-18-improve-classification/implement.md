# Implementation plan

1. Add the optional bounded sample contract and populate it from the smart-root tree.
2. Add local evidence scoring and candidate ranking, preserving weak-signal full-list behavior.
3. Update the classifier service cache fingerprint and provider dispatch.
4. Update the prompt with sample-aware, conservative instructions and bounded JSON input.
5. Add focused tests for sample extraction, scoring/ranking, prompt input, and cache invalidation.
6. Run typecheck, tests, build, and diff checks.
7. Run the Trellis quality review, update specs if the new contract is reusable knowledge, then prepare the work commit.
