# users/permissions.py
from rest_framework import permissions


class IsUserOrAdmin(permissions.BasePermission):
    """
    Custom permission to only allow owners of a user object or admins to edit it.
    """
    def has_object_permission(self, request, view, obj):
        # Allow admin users
        if request.user.is_staff:
            return True
        
        # Allow if the user is accessing their own record
        if hasattr(obj, 'user'):
            return obj.user == request.user
        return obj == request.user


class IsTeacherOrAdmin(permissions.BasePermission):
    """
    Custom permission to only allow teachers or admins to perform certain actions.
    """
    def has_permission(self, request, view):
        # Allow admin users
        if request.user.is_staff:
            return True
        
        # Allow if user is a teacher
        return request.user.is_authenticated and request.user.user_type == 'teacher'