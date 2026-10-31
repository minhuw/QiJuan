-- The book page's band colour, derived from the cover when it is stored: a pale #rrggbb tint.
-- NULL means not derived yet (the server backfills these at start); '' means the image gave no
-- clear hue or could not be read, and the page falls back to stock.

ALTER TABLE covers ADD COLUMN tint TEXT CHECK (tint IS NULL OR tint = '' OR (length(tint) = 7 AND tint GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'));
