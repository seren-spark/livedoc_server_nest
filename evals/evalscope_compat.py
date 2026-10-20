"""Client binding for EvalScope 1.13.0's legacy RAGAS metrics; scoring stays upstream.

Its factory creates new embed_text clients, but AnswerRelevancy requires embed_query.
Bind the supported LangChain wrappers for this run only; never edit site-packages.
"""
from contextlib import contextmanager


@contextmanager
def ragas_metric_clients():
    from evalscope.backend.rag_eval.ragas import task_template
    from langchain_openai import ChatOpenAI, OpenAIEmbeddings
    from ragas.llms import LangchainLLMWrapper
    from ragas.embeddings import LangchainEmbeddingsWrapper

    def build_llm(config):
        return LangchainLLMWrapper(ChatOpenAI(
            model=config.model_name, base_url=config.api_base, api_key=config.api_key,
            temperature=config.temperature, timeout=60, max_retries=1,
            max_tokens=config.max_tokens,
            model_kwargs={"response_format": {"type": "json_object"}},
        ))

    def build_embeddings(config):
        return LangchainEmbeddingsWrapper(OpenAIEmbeddings(
            model=config.model_name_or_path, base_url=config.api_base, api_key=config.api_key,
            check_embedding_ctx_length=False,
        ))

    original = task_template._build_llm, task_template._build_embeddings
    task_template._build_llm, task_template._build_embeddings = build_llm, build_embeddings
    try:
        yield
    finally:
        task_template._build_llm, task_template._build_embeddings = original
