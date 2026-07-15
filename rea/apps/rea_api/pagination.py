"""DRF pagination classes for the REA API.

The default ``PageNumberPagination`` ignores any client-supplied page size.
:class:`LargePageSizePagination` lets the client request a bigger page via
the ``page_size`` query param (capped at ``max_page_size``) so the frontend's
combination-category fetch — which needs every lesson in a category in one
go to filter client-side — can be done in a handful of round-trips instead
of dozens.  The cap prevents abuse.
"""

from rest_framework.pagination import PageNumberPagination


class LargePageSizePagination(PageNumberPagination):
    page_size = 50
    page_size_query_param = "page_size"
    max_page_size = 2000