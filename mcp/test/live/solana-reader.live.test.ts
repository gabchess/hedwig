import { expect } from "chai";

import {
  gatherSolanaRole,
  SIMULATE_DEADLINE_MS,
} from "../../src/readers/solana-role";

// Opt-in only: this file is discovered by the same glob as every other
// mocha test, but every describe below is skipped unless
// HEDWIG_LIVE_DEVNET=1 is set. CI never sets it, so this never runs there.
// Read-only against public Solana devnet: no transaction is ever sent, no
// private key is ever loaded. The fee payer below is an existing, funded,
// publicly known pubkey used only as an unsigned simulate target
// (sigVerify:false); it never signs anything here.
const RUN_LIVE = process.env.HEDWIG_LIVE_DEVNET === "1";

const RPC_URL = "https://api.devnet.solana.com";
const PROGRAM_ID = "H4J9wWhraK2Zvn4o9aFheFVmAf7nfaBNPw3d7w77X1eC";
const FUNDED_FEE_PAYER = "8gbaJEfM5VDs9BpFLgwMTq7s2FkVpEri8ZnPbxn4HPqY";

// A role/holder/membership triple known, at the time this was written, to
// exist and be enabled on public devnet.
const LIVE_ROLE = "3ESP4cYqqnCyz55z8jXsc6yLy8y1yCEmGmVJ8wm6dSNo";
const LIVE_HOLDER = "HpBXjrxJUbvbkFdjGKcuqeXLVbLBhT4KzWMtoenmJdVm";
const LIVE_MEMBER = "2eFex8mUN66zRcKoVy4WbUAKHNKJ7YGc6wkQb1P35wUP";

// A membership closed by a real revoke, against the same public devnet
// deployment: the member account no longer exists on chain.
const REVOKED_ROLE = "GHaoK8QGtwbrem5c897j1vqdp4A7GGFdJkrk8EjorWPo";
const REVOKED_HOLDER = "3hAuwCys7evuu6SjuXf7KtdqMD5Z19WAnySKemjd9RK2";
const REVOKED_MEMBER = "DB5zqsumVf9StECKUCKrhtYWf15xCLw1PFD57XTMrMVP";

function liveDeps() {
  return {
    fetch: globalThis.fetch,
    now: () => Math.floor(Date.now() / 1000),
    feePayer: FUNDED_FEE_PAYER,
    rpcUrl: RPC_URL,
    deadlineMs: SIMULATE_DEADLINE_MS,
  };
}

(RUN_LIVE ? describe : describe.skip)(
  "gatherSolanaRole against public Solana devnet (opt-in: HEDWIG_LIVE_DEVNET=1)",
  function () {
    this.timeout(10000);

    it("an enabled, currently held membership: valid true", async () => {
      const fact = await gatherSolanaRole(
        {
          mode: "required",
          cluster: "devnet",
          programId: PROGRAM_ID,
          role: LIVE_ROLE,
          holder: LIVE_HOLDER,
          member: LIVE_MEMBER,
          maxAgeSeconds: 60,
        },
        liveDeps()
      );

      // eslint-disable-next-line no-console
      console.log(
        "live devnet result (held membership):",
        JSON.stringify(fact)
      );
      expect(fact?.valid).to.equal(true);
      expect(fact?.reason).to.equal("ok");
    });

    it("a membership closed by a real revoke: MemberMissing", async () => {
      const fact = await gatherSolanaRole(
        {
          mode: "required",
          cluster: "devnet",
          programId: PROGRAM_ID,
          role: REVOKED_ROLE,
          holder: REVOKED_HOLDER,
          member: REVOKED_MEMBER,
          maxAgeSeconds: 60,
        },
        liveDeps()
      );

      // eslint-disable-next-line no-console
      console.log(
        "live devnet result (revoked membership):",
        JSON.stringify(fact)
      );
      expect(fact?.valid).to.equal(false);
      expect(fact?.reason).to.equal("MemberMissing");
    });
  }
);
