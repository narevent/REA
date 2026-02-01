# users/serializers.py
from rest_framework import serializers
from .models import User, Instrument, UserInstrument


class InstrumentSerializer(serializers.ModelSerializer):
    """
    Serializer for the Instrument model.
    """
    class Meta:
        model = Instrument
        fields = ('id', 'name', 'family', 'description')


class UserInstrumentSerializer(serializers.ModelSerializer):
    """
    Serializer for the UserInstrument relationship.
    """
    instrument_details = InstrumentSerializer(source='instrument', read_only=True)
    
    class Meta:
        model = UserInstrument
        fields = ('id', 'instrument', 'instrument_details', 'proficiency', 
                  'years_of_experience', 'notes')
        
    def to_representation(self, instance):
        representation = super().to_representation(instance)
        representation['instrument_name'] = instance.instrument.name
        return representation


class UserSerializer(serializers.ModelSerializer):
    """
    Serializer for the User model with all fields.
    """
    user_instruments = UserInstrumentSerializer(many=True, read_only=True)
    
    class Meta:
        model = User
        fields = ('id', 'username', 'email', 'first_name', 'last_name', 
                  'user_type', 'date_of_birth', 'date_joined', 'user_instruments')
        read_only_fields = ('date_joined', 'user_instruments')


class UserCreateSerializer(serializers.ModelSerializer):
    """
    Serializer for creating a user with password handling.
    """
    password = serializers.CharField(write_only=True)
    
    class Meta:
        model = User
        fields = ('id', 'username', 'email', 'first_name', 'last_name', 
                  'user_type', 'date_of_birth', 'password')
    
    def create(self, validated_data):
        password = validated_data.pop('password')
        user = User(**validated_data)
        user.set_password(password)
        user.save()
        return user


class TeacherSerializer(serializers.ModelSerializer):
    """
    Serializer specifically for teacher users.
    """
    user_instruments = UserInstrumentSerializer(many=True, read_only=True)
    
    class Meta:
        model = User
        fields = ('id', 'username', 'email', 'first_name', 'last_name', 
                  'date_joined', 'user_instruments')


class StudentSerializer(serializers.ModelSerializer):
    """
    Serializer specifically for student users.
    """
    user_instruments = UserInstrumentSerializer(many=True, read_only=True)
    
    class Meta:
        model = User
        fields = ('id', 'username', 'email', 'first_name', 'last_name', 
                  'date_of_birth', 'user_instruments')