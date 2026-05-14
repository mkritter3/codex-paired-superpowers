# Future-grep policy

Every v0.11+ feature spec MUST include the result of running these canonical grep commands against the installed plugin tree:

- `grep -r 'Implementers:'`
- `grep -r 'high_cost'`
- `grep -r 'expert-implementer'`

This catches feature drift early.
