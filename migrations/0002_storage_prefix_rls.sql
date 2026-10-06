-- Tighten storage RLS: enforce both owner and path-prefix isolation.
drop policy if exists materials_owner_all on storage.objects;
create policy materials_owner_all on storage.objects for all to authenticated
using (bucket_id = 'materials' and owner = auth.uid() and (storage.foldername(name))[1] = auth.uid()::text)
with check (bucket_id = 'materials' and owner = auth.uid() and (storage.foldername(name))[1] = auth.uid()::text);
