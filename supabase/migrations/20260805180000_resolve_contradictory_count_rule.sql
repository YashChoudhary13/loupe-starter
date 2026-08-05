-- Remove a self-contradiction 20260805170000 introduced into two describers.
--
-- That migration prepended the shared rules by replacing the "Rules:" header,
-- which correctly added the two-count hedging rule but left each preset's own
-- rule list untouched. For satin, marble and yellow that was harmless: they
-- take the rewritten jewellery describer wholesale, which never had the old
-- text. For hand-chain and bag — whose describers are domain-specific and were
-- edited in place — the result was a prompt holding both:
--
--   "describe the components and their order WITHOUT a total"
--   "- Exact counts are mandatory for visible pockets, closures, handles..."
--
-- A prompt that contradicts itself is worse than either rule alone: the model
-- picks one arbitrarily per call, which is precisely the inconsistency the
-- hedging rule exists to remove. Rewriting the lead-in keeps each preset's own
-- domain nouns and the useful remainder of the bullet, while deferring to the
-- shared two-count rule for how to handle uncertainty.

do $migration$
declare
  v_actor constant text := 'migration:20260805180000';
  v_hand_chain text;
  v_bag text;
begin
  select p.body into v_hand_chain from public.prompts as p
   where p.kind = 'describe' and p.preset_slug = 'hand-chain'
   order by p.created_at desc, p.id desc limit 1;
  select p.body into v_bag from public.prompts as p
   where p.kind = 'describe' and p.preset_slug = 'bag'
   order by p.created_at desc, p.id desc limit 1;

  if v_hand_chain is null or v_bag is null then
    raise exception 'count-rule fix could not read both preset describers';
  end if;
  if position('Exact counts are mandatory for' in v_hand_chain) = 0
     or position('Exact counts are mandatory for' in v_bag) = 0 then
    raise exception 'count-rule fix found nothing to correct — has it already run?';
  end if;

  v_hand_chain := replace(
    v_hand_chain,
    'Exact counts are mandatory for',
    'Apply the two-count rule above to'
  );
  v_bag := replace(
    v_bag,
    'Exact counts are mandatory for',
    'Apply the two-count rule above to'
  );

  if position('Exact counts are mandatory' in v_hand_chain) > 0
     or position('Exact counts are mandatory' in v_bag) > 0
     or position('WITHOUT a total' in v_hand_chain) = 0
     or position('WITHOUT a total' in v_bag) = 0
     or position('Describe the object, not the photograph' in v_hand_chain) = 0
     or position('Describe the object, not the photograph' in v_bag) = 0 then
    raise exception 'count-rule fix left the describers inconsistent';
  end if;

  insert into public.prompts (
    kind, name, body, model, is_default, archived_at, uses_composition, preset_slug, created_by
  )
  values
    ('describe', 'Hand chain — connection inspector, one count rule', v_hand_chain,
     'moonshotai/kimi-k3', false, now(), true, 'hand-chain', v_actor),
    ('describe', 'Bags — construction inspector, one count rule', v_bag,
     'moonshotai/kimi-k3', false, now(), true, 'bag', v_actor);

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'system', null, 'prompt.preset_revised',
    jsonb_build_object(
      'presets', jsonb_build_array('hand-chain', 'bag'),
      'reason', 'remove a contradictory mandatory-count rule left behind by 20260805170000',
      'promoted', false
    ),
    v_actor
  );
end;
$migration$;
