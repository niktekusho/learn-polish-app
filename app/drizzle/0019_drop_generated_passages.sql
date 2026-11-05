-- Passages are cut from read texts only: the LLM-written ones were all for non-words.
DELETE FROM `passage_question` WHERE `source` = 'generated';
