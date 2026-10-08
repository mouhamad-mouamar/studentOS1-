-- Additive, nullable page metadata for source-grounded citations.
-- Old chunks keep page_number = NULL and keep working unchanged.
ALTER TABLE public.chunks ADD COLUMN IF NOT EXISTS page_number integer;

COMMENT ON COLUMN public.chunks.page_number IS 'Optional page/slide number parsed from [Page n]/[Slide n] markers at ingest time; NULL for legacy chunks.';