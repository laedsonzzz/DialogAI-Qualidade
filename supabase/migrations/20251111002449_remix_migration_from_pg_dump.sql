--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--



--
-- Name: update_knowledge_base_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_knowledge_base_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


SET default_table_access_method = heap;

--
-- Name: conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scenario text NOT NULL,
    customer_profile text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    csat_score integer,
    feedback text,
    transcript jsonb DEFAULT '[]'::jsonb,
    process_id uuid
);


--
-- Name: knowledge_base; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knowledge_base (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    category text NOT NULL,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


--
-- Name: knowledge_base knowledge_base_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_base
    ADD CONSTRAINT knowledge_base_pkey PRIMARY KEY (id);


--
-- Name: knowledge_base update_knowledge_base_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_knowledge_base_updated_at BEFORE UPDATE ON public.knowledge_base FOR EACH ROW EXECUTE FUNCTION public.update_knowledge_base_updated_at();


--
-- Name: conversations conversations_process_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_process_id_fkey FOREIGN KEY (process_id) REFERENCES public.knowledge_base(id);


--
-- Name: conversations Anyone can create conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can create conversations" ON public.conversations FOR INSERT WITH CHECK (true);


--
-- Name: knowledge_base Anyone can create knowledge base entries; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can create knowledge base entries" ON public.knowledge_base FOR INSERT WITH CHECK (true);


--
-- Name: knowledge_base Anyone can delete knowledge base entries; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can delete knowledge base entries" ON public.knowledge_base FOR DELETE USING (true);


--
-- Name: conversations Anyone can update conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can update conversations" ON public.conversations FOR UPDATE USING (true);


--
-- Name: knowledge_base Anyone can update knowledge base entries; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can update knowledge base entries" ON public.knowledge_base FOR UPDATE USING (true);


--
-- Name: conversations Anyone can view conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can view conversations" ON public.conversations FOR SELECT USING (true);


--
-- Name: knowledge_base Anyone can view knowledge base; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can view knowledge base" ON public.knowledge_base FOR SELECT USING (true);


--
-- Name: conversations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

--
-- Name: knowledge_base; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.knowledge_base ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--


