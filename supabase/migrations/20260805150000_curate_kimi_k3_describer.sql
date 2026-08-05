-- Admit moonshotai/kimi-k3 to the curated describe models, and make it the
-- live describer.
--
-- The curated list is enforced twice on purpose: `src/lib/prompts/models.ts`
-- for the console selector, and `prompts_model_is_curated` in the database so
-- nothing can route around it. Both have to move together, so this migration is
-- the SQL half of the same change.
--
-- Evidence (2026-08-05, scripts/evaluate-description-models.ts over the five
-- Phase 3C acceptance sources, isolated — zero production writes):
--
--   candidate                      strict JSON  class  cost/image
--   qwen/qwen3.7-flash                    0/5      —   $0.00025   (empty result)
--   google/gemini-3.5-flash-lite          4/5    5/5   $0.001
--   moonshotai/kimi-k2.6                  0/5      —   $0.0065-0.0091 (empty result)
--   moonshotai/kimi-k3                    5/5    5/5   $0.0108-0.0217
--
-- kimi-k3 was the only candidate that returned strict valid JSON every time,
-- and the only one besides gemini to classify all five correctly. Against
-- openai/gpt-5.6-sol's observed production range of $0.021612-$0.053134 it is
-- roughly half the cost, and it sits inside the owner's stated $0.02-0.03
-- target. Sol had just breached the $0.05 ceiling on a live photograph.
--
-- NOT yet proven: the comparable five-product image run CLAUDE.md requires
-- before a describer change is considered accepted. The owner selected this
-- model explicitly and is running that acceptance themselves. Recorded as D87.

alter table public.prompts
  drop constraint if exists prompts_model_is_curated;

alter table public.prompts
  add constraint prompts_model_is_curated check (
    (
      kind = 'describe'
      and model in (
        'qwen/qwen3.7-flash',
        'google/gemini-3.5-flash-lite',
        'openai/gpt-5.6-luna-pro',
        'openai/gpt-5.4-mini',
        'anthropic/claude-haiku-4.5',
        'google/gemini-3.6-flash',
        'google/gemini-3.1-pro-preview',
        'openai/gpt-5.4',
        'anthropic/claude-sonnet-4.6',
        'moonshotai/kimi-k3',
        'openai/gpt-5.6-sol'
      )
    )
    or (
      kind = 'image'
      and model in (
        'black-forest-labs/flux.2-klein-4b',
        'black-forest-labs/flux.2-pro',
        'recraft/recraft-v4.1-utility',
        'bytedance-seed/seedream-4.5',
        'openai/gpt-image-1-mini',
        'x-ai/grok-imagine-image-quality',
        'black-forest-labs/flux.2-max',
        'google/gemini-3.1-flash-image',
        'google/gemini-3-pro-image',
        'openai/gpt-image-2'
      )
    )
  );

comment on constraint prompts_model_is_curated on public.prompts is
  'Curated model allow-list, mirroring src/lib/prompts/models.ts. Change both together: the console validates the selector, this constraint stops anything reaching the table another way.';
