-- Nyst v0.3.2 — Phase 9. WHAT THE VISITOR WAS ACTUALLY TOLD.
--
-- `nyst_quote_requests` recorded the inputs and the recommended PLAN NAME, and
-- nothing about the price. So a quote from March said "scale" and the price
-- that came back when anyone looked was whatever the catalog said today.
--
-- That is a small dishonesty with a sharp edge: a customer says "you quoted me
-- X" and Nyst cannot reconstruct whether they did. For a product whose entire
-- claim is that it can tell you what was true at a point in time, a sales
-- record that silently reprices itself is the wrong artefact to ship.
--
-- The exact display string is stored, not a number. A price is a SENTENCE on
-- the page -- "$2,400/month, from" -- and storing 240000 minor units loses the
-- qualifier that made it honest.

ALTER TABLE nyst_quote_requests
  ADD COLUMN IF NOT EXISTS price_display text
    CHECK (price_display IS NULL OR length(price_display) BETWEEN 1 AND 200),
  -- Which catalog produced it. A price change bumps this, so an old quote is
  -- attributable to the catalog that generated it rather than to the current one.
  ADD COLUMN IF NOT EXISTS pricing_catalog_version text
    CHECK (pricing_catalog_version IS NULL OR length(pricing_catalog_version) BETWEEN 1 AND 40),
  -- Whether the answer was "this needs a conversation" rather than a number.
  ADD COLUMN IF NOT EXISTS requires_conversation boolean,
  -- What Nyst told them it would NOT be covering. The honest half of a quote,
  -- and the half most likely to be disputed later.
  ADD COLUMN IF NOT EXISTS uncovered jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN nyst_quote_requests.price_display IS
  'The exact price string the visitor saw, verbatim. Not a number: a price is a sentence on the page, '
  'and "from" or "per month" is part of what made it honest. Historical quotes must stay reconstructable '
  'after the catalog changes.';
