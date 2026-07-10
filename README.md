# Welcome to @cap-js/cds-federation-synonyms

<!-- add reuse badge -->

## About this project

This plugin is still **experimental**.

For CAP applications using SAP HANA as database, this plugin enables
CAP-to-CAP data federation by integration on the database layer via synonyms.

In the database schema of the application that consumes the data ("consumer"), the
imported entities are represented as synonyms that point to the respective tables or
views in the database schema of the application that provides the data ("provider").
Acess to the producer is read-only.

Visit [CAP-level Data Federation](https://pages.github.tools.sap/cap/docs/guides/integration/data-federation#cap-level-data-federation)
to learn about the basics.

## Requirements

* @sap/cds-dk version 9.9 or higher.
* Both "provider" and "consumer" are CAP apps, using SAP HANA as database.
* Both "provider" and "consumer" run in the same SAP HANA instance, and,
  if Native Multitenancy in SAP HANA Cloud is switched on, live in the same tenant.




## Support, Feedback, Contributing

This project is open to feature requests/suggestions, bug reports etc. via [GitHub issues](https://github.com/cap-js/cds-federation-synonyms/issues). Contribution and feedback are encouraged and always welcome. For more information about how to contribute, the project structure, as well as additional contribution information, see our [Contribution Guidelines](CONTRIBUTING.md).

## Security / Disclosure

If you find any bug that may be a security problem, please follow the instructions found [in our security policy](https://github.com/cap-js/cds-federation-synonyms/security/policy) on how to report it. Please do not create GitHub issues for security-related doubts or problems.

## Code of Conduct

We as members, contributors, and leaders pledge to make participation in our community a harassment-free experience for everyone. By participating in this project, you agree to abide by its [Code of Conduct](https://github.com/cap-js/.github/blob/main/CODE_OF_CONDUCT.md) at all times.

## Licensing

Copyright (20xx-)20xx SAP SE or an SAP affiliate company and cds-federation-synonyms contributors. Please see our [LICENSE](./LICENSES/Apache-2.0.txt) for copyright and license information. Detailed information including third-party components and their licensing/copyright information is available [via the REUSE tool](https://api.reuse.software/info/github.com/cap-js/cds-federation-synonyms).
