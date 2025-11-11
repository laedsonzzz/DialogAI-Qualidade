-- Create conversations table if not exists
CREATE TABLE IF NOT EXISTS public.conversations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  scenario TEXT NOT NULL,
  customer_profile TEXT NOT NULL,
  process_id UUID,
  transcript JSONB DEFAULT '[]'::jsonb,
  ended_at TIMESTAMP WITH TIME ZONE,
  csat_score INTEGER,
  feedback JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create knowledge_base table if not exists
CREATE TABLE IF NOT EXISTS public.knowledge_base (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_base ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Allow all operations on conversations" ON public.conversations;
DROP POLICY IF EXISTS "Allow all operations on knowledge_base" ON public.knowledge_base;

-- Create policies for conversations (public access for training simulator)
CREATE POLICY "Allow all operations on conversations" 
ON public.conversations 
FOR ALL 
USING (true)
WITH CHECK (true);

-- Create policies for knowledge_base (public access)
CREATE POLICY "Allow all operations on knowledge_base" 
ON public.knowledge_base 
FOR ALL 
USING (true)
WITH CHECK (true);