export const PROOFS_FIXTURE = {
  schema: "voidly.session.provider.manifest/v1",
  provider_did: "did:voidly:E41eeJuRTVxE7411zGGF9H",
  signing_public_key_base64: "abJvEa/votvZLFZzFKEhwNxyBoIqBRYgvL6mrNysGFI=",
  encryption_public_key_base64: "CwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws=",
  attestor_public_key_base64: "ExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExM=",
  accept_url: "https://fixture.example.test/session/accept",
  hire_message_schema: "voidly-session-hire/v1",
  worker_base_url: "https://fixture.example.test",
  grant_ttl_ms: { min: 300000, max: 21600000 },
  acceptance_ttl_ms: 300000,
  services: [{
    ref: "sessions.public.fixture/v1",
    description: "Offline signature verification fixture only.",
    price: {
      chain: "eip155:8453",
      asset: "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      payee_account: "eip155:8453:0x2222222222222222222222222222222222222222",
      min_amount: "1", max_amount: "1",
    },
  }],
  payment_buys: "an attempt, not an outcome",
  notes: ["Public offline fixture. Never contact these example endpoints or use this manifest for a payment."],
  signature_base64: "1gE/tewhX6oLaymE2i1w2vrR5gzZv3WTz5EzIECoetx4Dma+aVTAZDyzSLDHeHi/fc57mO7Sd6+3cR/WjfcJDA==",
};
export const PROOFS_FIXTURE_DIGEST = "ccf7933183585166962b3244e19df341b6011895daa4fd43337011bc94b0846a";
