alter table public.reviews
  drop constraint if exists reviews_comment_check;

alter table public.reviews
  add constraint reviews_comment_check
  check (char_length(trim(comment)) between 0 and 150);
