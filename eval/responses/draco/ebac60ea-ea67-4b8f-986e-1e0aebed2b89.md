# Technical Analysis of Competing Digital Identity Standards

## Executive Summary

Digital identity systems diverge along a fundamental axis: whether identity is controlled by the state, the device, or the individual. Government-issued systems (eIDAS, Aadhaar, Estonia's e-Residency) offer legal recognition and scale but carry inherent surveillance footprints. FIDO/WebAuthn excels at phishing-resistant authentication but is fundamentally not an identity standard. W3C DIDs and Verifiable Credentials offer the strongest privacy and surveillance-resistance properties—particularly critical for stateless and displaced populations—but face maturity gaps in recovery mechanisms and real-world deployment.

---

## 1. The Three Paradigms

Digital identity standards fall into three architectural paradigms, each with distinct trust models:

| Dimension | W3C DIDs + VCs | FIDO2/WebAuthn | Government-Issued (eIDAS, Aadhaar, e-Residency) |
|---|---|---|---|
| **Trust Model** | Decentralized / Self-sovereign | Device-centric / Federation | Centralized / State-issued |
| **Core Function** | Identity assertion + verification | Authentication only | Identity assertion + authentication |
| **Identifier Type** | `did:method:method-specific-id` | Authenticator-bound public key | National ID number / smart card |
| **Data Registry** | Distributed ledgers, P2P networks | Relying party servers | Centralized state databases |
| **Governance** | W3C open standards | FIDO Alliance + W3C | National legislation |

---

## 2. Technical Architecture Deep Dive

### 2.1 W3C Decentralized Identifiers (DIDs) v1.0

Published as a W3C Recommendation on July 19, 2022, DIDs introduce a globally unique URI scheme that decouples identity management from any central authority. The architecture stores a **DID Document** (JSON-LD) on a Verifiable Data Registry—distributed ledgers, decentralized file systems, or peer-to-peer networks. This document contains public keys and service endpoints, while the corresponding private keys remain solely with the DID controller.

The ecosystem is method-rich: at publication, **103 experimental DID method specifications** and **46 implementations** existed, reflecting both the standard's flexibility and its fragmentation challenge. Because DIDs do not presuppose specific technology, they create an interoperability bridge between centralized, federated, and decentralized infrastructures. Crucially, DIDs can operate *alongside* FIDO/WebAuthn rather than competing with it—DIDs provide the identity layer, while FIDO provides the authentication layer.

### 2.2 W3C Verifiable Credentials (VCs) v2.0

Published May 15, 2025, the VC Data Model defines a three-party ecosystem: **Issuer** (governments, corporations), **Holder** (the individual), and **Verifier** (employers, service providers). Credentials are represented as tamper-evident JSON-LD documents secured by cryptographic proofs. Holders store credentials in repositories and present them to Verifiers as **Verifiable Presentations**.

This model directly competes with centralized government ID architectures by avoiding federated models where users are "tightly bound to the identity provider." The Holder/Subject distinction is architecturally significant—it accommodates custodial scenarios (e.g., a parent holding a child's credential), though specific recovery mechanisms are abstracted to the implementation layer.

### 2.3 FIDO2/WebAuthn

FIDO2 operates on a dual-component architecture: the **W3C WebAuthn API** (a JavaScript API built into modern browsers) and the **Client-to-Authenticator Protocol (CTAP)** for encrypted communication between client devices and external authenticators (YubiKeys, smartphones) via USB, NFC, or Bluetooth. All authentication relies on public-key cryptography: the private key never leaves the authenticator device.

FIDO2 is explicitly *not* an identity standard. It proves possession of a cryptographic key without storing or validating any personally identifiable information. This makes it fundamentally different from DIDs or government ID systems—it is an authentication mechanism that must be layered with an identity system for any use case requiring legal or attribute-based verification.

### 2.4 EU eIDAS 2.0 / European Digital Identity Wallet

Under eIDAS 2.0, every EU Member State must offer at least one certified **European Digital Identity Wallet** by the end of 2026. The architecture represents a significant shift: instead of users uploading full identity documents to corporate servers, individuals hold verifiable digital credentials locally on their devices, sharing them directly with requesting parties. The issuing authority does not automatically see when or where credentials are used—a design intentionally resistant to state surveillance.

The system is currently being tested through **four large-scale pilot programs** involving over **350 organizations across 26 Member States**, including the NOBID consortium (Nordic/Baltic payments) and POTENTIAL (cross-border digital driving licences).

### 2.5 India's Aadhaar

Aadhaar is the world's largest biometric ID system, managed by UIDAI under the Ministry of Electronics and Information Technology. It assigns a 12-digit unique identity number based on demographic data and biometrics (photograph, ten fingerprints, two iris scans) stored in a **centralized database**. As of May 2023, over **99.9% of India's adult population** is enrolled—roughly 1.3 billion people.

Authentication operates via real-time API verification against the state-controlled centralized biometric repository. Modes include demographic, fingerprint, iris, and face authentication (added in 2018). The system is deeply integrated into India's digital infrastructure, underpinning Direct Benefit Transfers (DBT) that have saved the government billions by eliminating "ghost beneficiaries."

### 2.6 Estonia's e-Residency / X-Road

Estonia's digital identity ecosystem is built on **X-Road**, an open-source data exchange layer that serves as the backbone of e-Estonia. All outgoing data is digitally signed and encrypted; all incoming data is authenticated and logged. X-Road processes **2.2 billion transactions per year** across **52,000+ organizations** and **3,000+ e-services**, and has been implemented in **20+ countries** worldwide.

The e-Residency program (launched 2014) provides a transnational digital identity via a smart-card-based digital ID with two PINs for authentication and digital signatures. Digital signatures are legally equivalent to handwritten signatures. Over **129,500 e-residents** and **37,000 e-resident companies** participate. X-Road supports cross-border federation—the Estonia-Finland federation was established in February 2018.

---

## 3. Comparative Analysis Across Key Dimensions

### 3.1 Privacy

| System | Privacy Model | Data Minimization | Correlation Resistance |
|---|---|---|---|
| **W3C DIDs + VCs** | Holder-controlled; unlimited DIDs per context | Strong via ZKPs + selective disclosure | Strong—no single tracking point |
| **FIDO2/WebAuthn** | Device-local; private key never leaves authenticator | Inherent—no PII stored by protocol | High per-relying-party isolation |
| **eIDAS 2.0 Wallet** | Local credential storage; issuer doesn't see usage | Strong via ZKPs + selective disclosure + MPC | Designed to prevent tracking; real-world TBD |
| **Aadhaar** | Centralized biometric repository; real-time API auth | Weak—full biometric+demographic profile stored | Poor—single identifier across all services |
| **Estonia e-Residency** | Government PKI; X-Road logs all transactions | Moderate—data exchanged on need-to-know basis | Moderate—state can audit all transactions |

**Key finding:** W3C DIDs/VCs offer the strongest architectural privacy. Users can maintain unlimited separate DIDs for different contexts, enabling strict separation of identities and interactions. The VC v2.0 specification explicitly warns about correlation risks and mandates support for ZKPs and selective disclosure. eIDAS 2.0's wallet architecture adopts similar principles (local storage, ZKPs, MPC), but its government-governed framework means the state ultimately controls the credential issuance infrastructure.

Aadhaar represents the weakest privacy model: a single 12-digit number links to all services, with biometric data centrally stored. The 2017 Supreme Court ruling establishing privacy as a fundamental right, and the 2018 ruling restricting Aadhaar's mandatory use, were direct responses to these architectural weaknesses.

### 3.2 Interoperability

| System | Cross-Platform | Cross-Jurisdictional | Standardization Body |
|---|---|---|---|
| **W3C DIDs + VCs** | High (open web standards) | High (no jurisdiction dependency) | W3C |
| **FIDO2/WebAuthn** | High (built into all major browsers) | High (no jurisdiction dependency) | W3C + FIDO Alliance |
| **eIDAS 2.0 Wallet** | Medium (EU-specific, 27 Member States) | Medium (EU + mutual recognition agreements) | EU Commission + CEN/ETSI |
| **Aadhaar** | Low (India-specific) | Very Low (no cross-border framework) | UIDAI / Government of India |
| **Estonia e-Residency** | Medium (X-Road federation model) | Medium (20+ countries using X-Road) | Government of Estonia |

**Key finding:** W3C standards and FIDO2 achieve the broadest interoperability through open web standards. eIDAS 2.0's 350+ organization pilot program represents the most ambitious government interoperability effort, but it remains confined to the EU. X-Road's federation model is technically proven (Estonia-Finland since 2018) and spreading to 20+ countries. Aadhaar has no meaningful cross-border interoperability.

### 3.3 Resistance to Surveillance

**W3C DIDs/VCs** offer the strongest surveillance resistance by design. The architecture eliminates single honeypots of data. Credential verifiers do not need to contact the issuer, meaning no party has a complete view of an individual's credential usage. The ability to generate unlimited DIDs for different contexts makes correlation attacks architecturally difficult.

**FIDO2/WebAuthn** provides high surveillance resistance for authentication flows. Since no central server stores biometric templates or passwords, mass surveillance through credential databases is architecturally impossible. However, the relying party can still correlate authentication events.

**eIDAS 2.0** represents a nuanced middle ground. The wallet architecture is explicitly designed so that the issuing authority does not see when or where credentials are used—a direct response to surveillance concerns. However, the state-controlled issuance infrastructure and the 350+ organization pilot ecosystem create a latent surveillance capability that depends on governance safeguards rather than architectural impossibility.

**Aadhaar** is the most surveillance-vulnerable system analyzed. The centralized biometric database, combined with integration across banking, telecommunications, welfare, and government services, creates a comprehensive activity trail. The Indian government's aggressive linking of Aadhaar to critical services (despite Supreme Court restrictions) has been widely criticized by privacy advocates. Researchers have raised feasibility concerns about securing biometric data at such massive scale.

**Estonia's X-Road** provides strong security (all data signed, encrypted, and logged) but the state has complete audit visibility. The architecture is transparent by design—designed to reduce corruption and increase government accountability, not to resist state surveillance.

### 3.4 Recovery Mechanisms for Lost Credentials

This is perhaps the most significant differentiator—and the area where all systems show weaknesses.

| System | Recovery Mechanism | Strengths | Weaknesses |
|---|---|---|---|
| **W3C DIDs + VCs** | Left to DID method implementers; options include multi-sig, social recovery, decentralized custodians | Flexible; can be tailored to threat model | No standardized recovery; fragmentation risk; user responsibility is high |
| **FIDO2/WebAuthn** | Register multiple backup authenticators; trusted device verification; AI-verified video selfies; account recovery codes | Phishing-resistant fallbacks available | If all authenticators lost, credential is permanently lost; highly device-dependent |
| **eIDAS 2.0 Wallet** | National authority-managed recovery | Institutional support; regulated process | Depends on government processes; potential privacy exposure during recovery |
| **Aadhaar** | Re-enrollment via UIDAI centers; biometric re-capture | Institutional fallback exists | Risk of total exclusion if biometrics degrade (manual laborers, elderly); requires physical visit to enrollment center |
| **Estonia e-Residency** | Re-apply for new digital ID card via government | Institutional process | Requires physical pickup at embassy; weeks-long process; no emergency mechanism |

**Key finding:** Recovery represents the sharpest trade-off between sovereignty and safety. Decentralized systems (DIDs) offer maximum control but maximum responsibility—if you lose your keys without a recovery mechanism, your identity is irrecoverable. Government systems offer institutional recovery but require trust in the state and physical access to recovery infrastructure. For displaced or stateless populations, neither model is fully adequate.

Aadhaar's biometric degradation problem is particularly severe: manual laborers whose fingerprints wear down, or elderly individuals whose biometrics change, can be permanently locked out of the system. This is not a theoretical concern—it has been documented as a cause of welfare exclusion.

### 3.5 Suitability by Use Case

#### Banking and Financial Services
- **FIDO2/WebAuthn**: Ideal for authentication—prevents account takeovers, reduces password reset costs. Already adopted by major banks.
- **eIDAS 2.0**: Strong fit for EU cross-border banking; wallet credentials can satisfy KYC/AML requirements across Member States.
- **Aadhaar**: Deeply integrated into Indian banking via e-KYC; enables instant account opening for 1.3 billion people.
- **W3C DIDs/VCs**: Suitable for cross-border and crypto-adjacent banking; VC standards can represent financial credentials, but adoption is nascent.
- **Estonia e-Residency**: Purpose-built for EU business banking and company formation.

#### Healthcare
- **W3C DIDs/VCs**: Strong fit—medical credentials, prescriptions, and insurance claims can be represented as VCs with selective disclosure protecting sensitive health data.
- **eIDAS 2.0**: Well-suited for EU cross-border healthcare credential portability.
- **FIDO2**: Useful for clinician and patient authentication to EHR systems, but cannot represent medical credentials alone.
- **Aadhaar**: Used for health insurance (Ayushman Bharat) and hospital identification, but raises serious medical privacy concerns due to centralized architecture.

#### Humanitarian Aid / Stateless Populations
- **W3C DIDs/VCs**: The most suitable framework. DIDs do not require foundational national IDs, allowing stateless persons, refugees, and those lacking government recognition to hold cryptographic proof of identity. UNHCR's increasing engagement with decentralized identity standards reflects this. The absence of a required central authority means identity functions even when state infrastructure is destroyed or hostile.
- **FIDO2/WebAuthn**: Highly problematic. Stateless persons and refugees frequently lack stable hardware access and are at high risk of device loss—FIDO's device-bound credentials become a liability rather than a feature.
- **Government systems (all)**: Fundamentally inadequate for stateless populations. eIDAS requires EU citizenship/residency. Aadhaar requires Indian residency. Estonia's e-Residency requires existing foundational identity documents to apply. These systems are *designed to exclude* those without state recognition.

UNHCR's **PRIMES** (Population Registration and Identity Management Ecosystem) bridges this gap for humanitarian contexts, integrating biometric enrollment, case management, and aid distribution across 93 countries. However, PRIMES itself operates as a centralized humanitarian authority—a necessary compromise in crisis contexts, but one that creates its own data protection obligations and surveillance risks for vulnerable populations.

---

## 4. Synthesis: The Fundamental Tensions

### Authentication vs. Identity
The most common confusion in digital identity discourse is conflating authentication with identity. FIDO2/WebAuthn solves authentication exceptionally well but deliberately does not address identity assertion. DIDs and VCs address identity assertion and verification. Government systems attempt both. Any complete digital identity solution requires both layers.

### Sovereignty vs. Recovery
The more control an individual has over their identity (DIDs), the more catastrophic the failure mode when credentials are lost. The more the state controls identity (Aadhaar, eIDAS), the easier recovery becomes—but at the cost of surveillance exposure and exclusion of those outside state systems.

### Scale vs. Privacy
Aadhaar demonstrates that centralized biometric systems can achieve unprecedented scale (1.3 billion enrolled) and deliver measurable welfare improvements (billions saved through ghost beneficiary elimination). This scale comes at the cost of creating the world's largest biometric database—a single point of failure with profound surveillance implications.

### Standards Fragmentation
The W3C DID ecosystem's strength (103 methods, 46 implementations) is also its weakness. Without a standardized recovery mechanism or a dominant DID method, interoperability in practice remains challenging. eIDAS 2.0's approach—government-mandated standards with large-scale pilots—may achieve practical interoperability faster, albeit within a geographically bounded framework.

---

## Sources

1. W3C, "Decentralized Identifiers (DIDs) v1.0," July 19, 2022. [w3.org/TR/did-core/](https://www.w3.org/TR/did-core/)
2. W3C, "Verifiable Credentials Data Model v2.0," May 15, 2025. [w3.org/TR/vc-data-model-2.0/](https://www.w3.org/TR/vc-data-model-2.0/)
3. Corbado, "WebAuthn vs. CTAP vs. FIDO2: Key Differences." [corbado.com](https://www.corbado.com/blog/webauthn-vs-ctap-vs-fido2)
4. Security Boulevard, "Demystifying FIDO2 Architecture: A Developer's Guide to Passwordless Authentication," August 2025. [securityboulevard.com](https://securityboulevard.com/2025/08/demystifying-fido2-architecture-a-developers-guide-to-passwordless-authentication/)
5. Deepak Gupta, "FIDO2 and WebAuthn: Passwordless Authentication Standards for CIAM." [guptadeepak.com](https://guptadeepak.com/customer-identity-hub/fido2-webauthn-passwordless-authentication-standards-ciam)
6. The European Business Review, "eIDAS 2.0 and the EU Digital Identity Wallet Explained." [europeanbusinessreview.com](https://www.europeanbusinessreview.com/eidas-2-0-and-the-eu-digital-identity-wallet-hype-fear-and-business-reality/)
7. e-Estonia, "X-Road." [e-estonia.com/solutions/interoperability-services/x-road/](https://e-estonia.com/solutions/interoperability-services/x-road/)
8. e-Estonia, "e-Residency." [e-estonia.com/solutions/estonian-e-identity/e-residency/](https://e-estonia.com/solutions/estonian-e-identity/e-residency/)
9. Wikipedia, "Aadhaar." [en.wikipedia.org/wiki/Aadhaar](https://en.wikipedia.org/wiki/Aadhaar)
10. UNHCR, "Registration and Identity Management." [unhcr.org](https://www.unhcr.org/what-we-do/protect-human-rights/protection/registration-and-identity-management)

---

## Uncertainty & Gaps

- **eIDAS 2.0 real-world privacy**: The wallet system's surveillance-resistance claims are architectural and unproven at scale. The 2026 deployment deadline will be the true test of whether the cryptography delivers on its privacy promises across 27 sovereign implementations.
- **DID/VC adoption metrics**: No reliable data was found on real-world deployment scale of W3C DID/VC systems outside pilot programs. The ecosystem remains largely experimental.
- **Aadhaar breach data**: While Wikipedia references data breach concerns, specific technical analyses of actual breach incidents were not fully verified through primary security research sources.
- **Recovery in practice**: Detailed comparison of how recovery actually works for users across all systems (success rates, time-to-recovery, failure modes) was not available in the sources consulted.
- **FIDO passkeys vs. hardware keys**: The emerging shift from hardware-bound FIDO credentials to synced passkeys (via cloud providers) changes the recovery calculus significantly, but detailed technical analysis of this transition was beyond the scope of sources found.