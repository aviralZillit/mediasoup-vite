/* eslint-disable max-len */
const Calls = require('../model/mediasoupCall');
const createCall = (data) => Calls.create(data);

const getCall = ({ filters }) => Calls.findOne({ ...filters });

const getCalls = ({ filters, sort, limit }) => 
{
	if (Number(limit) > 0) 
	{
		return Calls.find({ ...filters })
			.sort({ ...sort })
			.limit(limit);
	}

	return Calls.find({ ...filters })
		.sort({ ...sort });
};

const updateCalls = ({ filters, data }) => Calls.updateMany({ ...filters }, { $set: { ...data } });

const updateCall = async ({ filters, data }) => 
{
	return Calls.updateOne(
		{ ...filters }, 
		{ $set: data }
	);
};

module.exports = {
	getCall,
	getCalls,
	createCall,
	updateCalls,
	updateCall
};